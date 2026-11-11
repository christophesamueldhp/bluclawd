/*
 * Finds and ends the processes of one subagent run's shell on macOS.
 *
 * A run's commands run under a Seatbelt profile that allows looking up one Mach name no other profile names:
 * the run's marker. A process cannot leave or drop its Seatbelt profile, and every process it starts inherits it,
 * so the run's processes are exactly the sandboxed ones allowed that name and refused another, its control name
 * (a profile allowing every lookup allows both). No parentage, session or environment is followed: a detached,
 * double-forked, setsid or environment-scrubbed descendant is found by any scan after it exists.
 *
 *   run-members members <marker>   prints the pid of each live member, one per line
 *   run-members end <marker>       stops every member until none runs, kills them all, and exits 0 once a scan
 *                                  finds none left, 1 if some still live (printing their pids)
 *
 * sandbox_check is private SPI of libsystem_sandbox; PROC_PIDUNIQIDENTIFIERINFO (flavor 17) is xnu's.
 */
#include <libproc.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc.h>
#include <sys/proc_info.h>
#include <unistd.h>

#define SANDBOX_FILTER_NONE 0
#define SANDBOX_FILTER_GLOBAL_NAME 2
#define SANDBOX_CHECK_NO_REPORT 0x40000000
#define PROC_PIDUNIQIDENTIFIERINFO 17
#define MAX_PIDS 16384
#define MAX_STOP_ROUNDS 200
#define END_ROUNDS 100
#define POLL_US 10000

extern int sandbox_check(pid_t pid, const char *operation, int type, ...);

struct proc_uniqidentifierinfo {
  uint8_t p_uuid[16];
  uint64_t p_uniqueid;
  uint64_t p_puniqueid;
  int32_t p_idversion;
  uint32_t p_reserve2;
  uint64_t p_reserve3;
  uint64_t p_reserve4;
};

struct member { int pid; uint64_t id; };

static const char *marker;
static char control[512];
static int pids[MAX_PIDS];
static struct member members[MAX_PIDS];

static int unique_id(int pid, uint64_t *id) {
  struct proc_uniqidentifierinfo info;
  if (proc_pidinfo(pid, PROC_PIDUNIQIDENTIFIERINFO, 0, &info, sizeof(info)) != sizeof(info)) return 0;
  *id = info.p_uniqueid;
  return 1;
}

static int is_member(int pid) {
  if (sandbox_check(pid, NULL, SANDBOX_FILTER_NONE | SANDBOX_CHECK_NO_REPORT) != 1) return 0;
  return sandbox_check(pid, "mach-lookup", SANDBOX_FILTER_GLOBAL_NAME | SANDBOX_CHECK_NO_REPORT, marker) == 0 &&
         sandbox_check(pid, "mach-lookup", SANDBOX_FILTER_GLOBAL_NAME | SANDBOX_CHECK_NO_REPORT, control) == 1;
}

/* A zombie runs nothing more: it only waits for its parent to collect it. One that cannot be read may run. */
static int zombie(int pid) {
  struct proc_bsdinfo info;
  if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != sizeof(info)) return 0;
  return info.pbi_status == SZOMB;
}

static int stopped(int pid) {
  struct proc_bsdinfo info;
  if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != sizeof(info)) return 0;
  return info.pbi_status == SSTOP || info.pbi_status == SZOMB;
}

/*
 * The live members, by pid and unique id (0 for one whose id cannot be read: counted, never signalled); -1 when the
 * processes cannot all be listed. Whatever cannot be told apart counts as a member still running, never as gone.
 */
static int scan(void) {
  int count = proc_listallpids(pids, sizeof(pids));
  if (count < 0 || count >= MAX_PIDS) return -1;
  int n = 0;
  for (int i = 0; i < count; i++) {
    int pid = pids[i];
    if (pid <= 1 || pid == getpid() || !is_member(pid) || zombie(pid)) continue;
    uint64_t id;
    members[n++] = (struct member){pid, unique_id(pid, &id) ? id : 0};
  }
  return n;
}

/* Signals a member, unless its pid now names another process. */
static int signal_member(const struct member *m, int sig) {
  uint64_t id;
  if (m->id == 0 || !unique_id(m->pid, &id) || id != m->id) return 0;
  return kill(m->pid, sig) == 0;
}

static int end(void) {
  /* Stopped members cannot fork, so once a scan finds none left running, every member is known. */
  for (int round = 0, running = 1; running && round < MAX_STOP_ROUNDS; round++) {
    running = 0;
    int live = scan();
    if (live < 0) return 1;
    for (int i = 0; i < live; i++)
      if (!stopped(members[i].pid)) running += signal_member(&members[i], SIGSTOP);
  }
  for (int round = 0; round < END_ROUNDS; round++) {
    int live = scan();
    if (live < 0) return 1;
    if (live == 0) return 0;
    for (int i = 0; i < live; i++) signal_member(&members[i], SIGKILL);
    usleep(POLL_US);
  }
  int live = scan();
  for (int i = 0; i < live; i++) printf("%d\n", members[i].pid);
  return live == 0 ? 0 : 1;
}

int main(int argc, char **argv) {
  if (argc != 3 || strlen(argv[2]) == 0 || strlen(argv[2]) > 400) return 2;
  marker = argv[2];
  snprintf(control, sizeof(control), "%s.control", marker);
  if (!strcmp(argv[1], "members")) {
    int live = scan();
    if (live < 0) return 1;
    for (int i = 0; i < live; i++) printf("%d\n", members[i].pid);
    return 0;
  }
  if (!strcmp(argv[1], "end")) return end();
  return 2;
}
