/*
 * Follows one sandboxed command's processes on macOS and kills them when told to stop.
 *
 * The first stdin line is the command's cookie. A process born after this helper is a member when
 * its environment carries BLUCLAWD_REAPER_COOKIE=<cookie>, or when its parent unique id is a
 * member's. That id survives reparenting to launchd, so a detached or double-forked descendant
 * stays a member, even with a scrubbed environment, as long as a scan saw its parent.
 *
 * A "stop" line or the end of stdin stops every member (SIGSTOP until a scan finds no new one),
 * kills them all, scans once more, prints "reaped" and exits.
 *
 * PROC_PIDUNIQIDENTIFIERINFO (flavor 17) is private SPI; the layout is xnu's.
 */
#include <errno.h>
#include <libproc.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/select.h>
#include <sys/sysctl.h>
#include <unistd.h>

#define PROC_PIDUNIQIDENTIFIERINFO 17
#define MAX_PIDS 16384
#define MAX_MEMBERS 65536
#define POLL_US 10000

struct proc_uniqidentifierinfo {
  uint8_t p_uuid[16];
  uint64_t p_uniqueid;
  uint64_t p_puniqueid;
  int32_t p_idversion;
  uint32_t p_reserve2;
  uint64_t p_reserve3;
  uint64_t p_reserve4;
};

struct proc { int pid; uint64_t id, parent; };

static const char key[] = "BLUCLAWD_REAPER_COOKIE=";
static char cookie[65];
static uint64_t born_after;
static int owner;
/* Unique ids of every member seen, dead ones included, sorted. */
static uint64_t members[MAX_MEMBERS];
static int member_count;
static struct proc procs[MAX_PIDS];
static int pids[MAX_PIDS];

static int identify(int pid, struct proc_uniqidentifierinfo *info) {
  return proc_pidinfo(pid, PROC_PIDUNIQIDENTIFIERINFO, 0, info, sizeof(*info)) == sizeof(*info);
}

/* The index of the first member id not below `id`. */
static int lower_bound(uint64_t id) {
  int lo = 0, hi = member_count;
  while (lo < hi) {
    int mid = (lo + hi) / 2;
    if (members[mid] < id) lo = mid + 1; else hi = mid;
  }
  return lo;
}

static int is_member(uint64_t id) {
  int at = lower_bound(id);
  return at < member_count && members[at] == id;
}

static void add_member(uint64_t id) {
  int at = lower_bound(id);
  if (member_count == MAX_MEMBERS || (at < member_count && members[at] == id)) return;
  memmove(members + at + 1, members + at, (size_t)(member_count - at) * sizeof(members[0]));
  members[at] = id;
  member_count++;
}

static int carries_cookie(int pid) {
  static char buffer[1 << 20];
  int mib[] = {CTL_KERN, KERN_PROCARGS2, pid};
  size_t size = sizeof(buffer);
  if (sysctl(mib, 3, buffer, &size, NULL, 0) != 0 || size < sizeof(int)) return 0;
  int argc;
  memcpy(&argc, buffer, sizeof(argc));
  char *p = buffer + sizeof(argc), *end = buffer + size;
  /* The executable path and argc arguments, NUL-padded, then the environment. */
  for (int i = -1; i < argc && p < end; i++) {
    char *zero = memchr(p, 0, (size_t)(end - p));
    if (!zero) return 0;
    p = zero + 1;
    while (p < end && !*p) p++;
  }
  size_t length = sizeof(key) - 1 + 64;
  while (p < end && *p) {
    char *zero = memchr(p, 0, (size_t)(end - p));
    if (!zero) return 0;
    if ((size_t)(zero - p) == length && !memcmp(p, key, sizeof(key) - 1) && !memcmp(p + sizeof(key) - 1, cookie, 64))
      return 1;
    p = zero + 1;
  }
  return 0;
}

static int by_id(const void *a, const void *b) {
  uint64_t x = ((const struct proc *)a)->id, y = ((const struct proc *)b)->id;
  return x < y ? -1 : x > y;
}

/* Records new members and fills procs with the live ones; returns their count. */
static int scan(void) {
  int count = proc_listallpids(pids, sizeof(pids));
  int n = 0;
  for (int i = 0; i < count && i < MAX_PIDS; i++) {
    struct proc_uniqidentifierinfo info;
    if (pids[i] <= 1 || pids[i] == getpid() || pids[i] == owner) continue;
    if (!identify(pids[i], &info) || info.p_uniqueid <= born_after) continue;
    procs[n++] = (struct proc){pids[i], info.p_uniqueid, info.p_puniqueid};
  }
  /* A child's id is larger than its parent's, so parents are classified first. */
  qsort(procs, (size_t)n, sizeof(procs[0]), by_id);
  int live = 0;
  for (int i = 0; i < n; i++) {
    struct proc *p = &procs[i];
    if (!is_member(p->id) && (is_member(p->parent) || carries_cookie(p->pid))) add_member(p->id);
    if (is_member(p->id)) procs[live++] = *p;
  }
  return live;
}

/* Signals a member, unless its pid now names another process. */
static int signal_member(const struct proc *p, int sig) {
  struct proc_uniqidentifierinfo info;
  if (!identify(p->pid, &info) || info.p_uniqueid != p->id) return 0;
  return kill(p->pid, sig) == 0;
}

static void reap(void) {
  /* Stopped members cannot fork, so once a scan finds no member left running, the set is complete. */
  for (int round = 0, running = 1; running && round < 100; round++) {
    running = 0;
    int live = scan();
    for (int i = 0; i < live; i++) {
      struct proc_bsdinfo info;
      if (proc_pidinfo(procs[i].pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != sizeof(info)) continue;
      if (info.pbi_status == SSTOP || info.pbi_status == SZOMB) continue;
      running += signal_member(&procs[i], SIGSTOP);
    }
  }
  for (int pass = 0; pass < 2; pass++) {
    int live = scan();
    for (int i = 0; i < live; i++) signal_member(&procs[i], SIGKILL);
    if (pass == 0) usleep(POLL_US);
  }
  printf("reaped\n");
  fflush(stdout);
}

int main(void) {
  struct proc_uniqidentifierinfo self;
  char line[128];
  if (!identify(getpid(), &self) || !fgets(line, sizeof(line), stdin) || strlen(line) != 65 || line[64] != '\n')
    return 2;
  memcpy(cookie, line, 64);
  born_after = self.p_uniqueid;
  owner = getppid();
  printf("ready\n");
  fflush(stdout);
  for (;;) {
    scan();
    fd_set read;
    FD_ZERO(&read);
    FD_SET(STDIN_FILENO, &read);
    struct timeval wait = {0, POLL_US};
    int ready = select(STDIN_FILENO + 1, &read, NULL, NULL, &wait);
    /* Any input is "stop"; the end of stdin means the owner is gone. */
    if (ready > 0 || (ready < 0 && errno != EINTR)) break;
  }
  reap();
  return 0;
}
