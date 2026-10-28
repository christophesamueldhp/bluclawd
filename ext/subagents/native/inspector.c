#include <errno.h>
#include <limits.h>
#include <libproc.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc.h>
#include <sys/sysctl.h>
#include <unistd.h>

#define MAX_PIDS 10000
#define MAX_RESPONSE (256 * 1024)
static const char run_key[] = "BLUCLAWD_SUBAGENT_RUN_COOKIE=";
static const char command_key[] = "BLUCLAWD_SUBAGENT_COMMAND_COOKIE=";
static char run_cookie[65], command_cookie[65];
static char *args_buffer;
static size_t args_capacity;
static char output[MAX_RESPONSE + 1];

static void wipe(void *buffer, size_t size) {
  volatile unsigned char *p = buffer;
  while (size--) *p++ = 0;
}

static int fail(const char *op, const char *code) {
  printf("{\"version\":1,\"op\":\"%s\",\"error\":{\"code\":\"%s\"}}\n", op, code);
  return 1;
}

static uint64_t born(const struct proc_bsdinfo *info) {
  return info->pbi_start_tvsec * UINT64_C(1000000) + info->pbi_start_tvusec;
}

static int inspect(int pid, struct proc_bsdinfo *info) {
  memset(info, 0, sizeof(*info));
  errno = 0;
  return proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, info, sizeof(*info)) == sizeof(*info);
}

static int decimal(const char *text, uint64_t max, uint64_t *value) {
  size_t n = strlen(text);
  if (!n || n > 20 || strspn(text, "0123456789") != n || (n > 1 && text[0] == '0')) return 0;
  errno = 0;
  unsigned long long parsed = strtoull(text, NULL, 10);
  if (errno || parsed > max) return 0;
  *value = parsed;
  return 1;
}

static int hex_cookie(const char *p) {
  for (int i = 0; i < 64; i++) {
    if (!((p[i] >= '0' && p[i] <= '9') || (p[i] >= 'a' && p[i] <= 'f'))) return 0;
  }
  return 1;
}

static int read_cookies(void) {
  char request[4097];
  size_t used = 0;
  while (used < sizeof(request)) {
    ssize_t count = read(STDIN_FILENO, request + used, sizeof(request) - used);
    if (count < 0 && errno == EINTR) continue;
    if (count < 0) { wipe(request, sizeof(request)); return 0; }
    if (!count) break;
    used += (size_t)count;
  }
  int valid = (used == 66 || used == 130) && request[64] == '\n' &&
    request[used - 1] == '\n' && hex_cookie(request) && (used == 66 || hex_cookie(request + 65));
  if (valid) {
    memcpy(run_cookie, request, 64);
    if (used == 130) memcpy(command_cookie, request + 65, 64);
  }
  wipe(request, sizeof(request));
  return valid;
}

/* Cookies are mutable discovery hints, not kernel ownership or authorization. */
static int matches(int pid) {
  int mib[] = {CTL_KERN, KERN_PROCARGS2, pid};
  size_t size = args_capacity;
  if (sysctl(mib, 3, args_buffer, &size, NULL, 0) != 0 || size < sizeof(int) || size > args_capacity) return -1;
  int count;
  memcpy(&count, args_buffer, sizeof(count));
  if (count <= 0 || count > 32768) return -1;
  char *p = args_buffer + sizeof(count), *end = args_buffer + size;
  char *zero = memchr(p, 0, (size_t)(end - p));
  if (!zero) return -1;
  p = zero + 1;
  while (p < end && !*p) p++;
  for (int i = 0; i < count; i++) {
    zero = memchr(p, 0, (size_t)(end - p));
    if (!zero) return -1;
    p = zero + 1;
  }
  /* process.title can leave NUL padding between argv and the environment. */
  while (p < end && !*p) p++;
  int runs = 0, commands = 0, run_match = 0, command_match = 0;
  while (p < end && *p) {
    zero = memchr(p, 0, (size_t)(end - p));
    if (!zero) return -1;
    size_t length = (size_t)(zero - p);
    if (length >= sizeof(run_key) - 1 && !memcmp(p, run_key, sizeof(run_key) - 1)) {
      runs++;
      run_match = length == sizeof(run_key) - 1 + 64 && !memcmp(p + sizeof(run_key) - 1, run_cookie, 64);
    }
    if (length >= sizeof(command_key) - 1 && !memcmp(p, command_key, sizeof(command_key) - 1)) {
      commands++;
      command_match = length == sizeof(command_key) - 1 + 64 && !memcmp(p + sizeof(command_key) - 1, command_cookie, 64);
    }
    p = zero + 1;
  }
  return runs == 1 && run_match && (!command_cookie[0] || (commands == 1 && command_match));
}

static int protected_pid(int pid) {
  if (pid <= 1 || pid == getpid()) return 1;
  int parent = getppid();
  for (int i = 0; i < 64 && parent > 1; i++) {
    if (parent == pid) return 1;
    struct proc_bsdinfo info;
    if (!inspect(parent, &info)) return -1;
    if ((int)info.pbi_ppid == parent) return -1;
    parent = (int)info.pbi_ppid;
  }
  return parent > 1 ? -1 : 0;
}

static int scan(void) {
  int capacity = proc_listallpids(NULL, 0);
  if (capacity <= 0) return fail("scan", "inspection_failed");
  capacity = capacity > MAX_PIDS - 128 ? MAX_PIDS : capacity + 128;
  int *pids = calloc((size_t)capacity, sizeof(int));
  if (!pids) return fail("scan", "internal");
  int count = proc_listallpids(pids, capacity * (int)sizeof(int));
  if (count <= 0 || count > capacity) { free(pids); return fail("scan", "inspection_failed"); }
  int truncated = count == capacity, unreadable = 0, first = 1;
  size_t used = (size_t)snprintf(output, sizeof(output), "{\"version\":1,\"op\":\"scan\",\"result\":{\"matches\":[");
  for (int i = 0; i < count; i++) {
    int pid = pids[i];
    if (pid <= 1 || pid == getpid() || pid == getppid()) continue;
    struct proc_bsdinfo info;
    if (!inspect(pid, &info)) { unreadable++; continue; }
    if (info.pbi_uid != geteuid() || info.pbi_status == SZOMB) continue;
    int match = matches(pid);
    if (match < 0) { unreadable++; continue; }
    if (!match) continue;
    int protected = protected_pid(pid);
    if (protected) { unreadable++; continue; }
    struct proc_bsdinfo fresh;
    if (!inspect(pid, &fresh) || fresh.pbi_uid != info.pbi_uid || born(&fresh) != born(&info)) {
      unreadable++; continue;
    }
    char entry[128];
    int length = snprintf(entry, sizeof(entry), "%s{\"pid\":%d,\"uid\":%u,\"startMicros\":\"%llu\"}",
      first ? "" : ",", pid, info.pbi_uid, (unsigned long long)born(&info));
    if (length < 0 || (size_t)length >= sizeof(entry) || used + (size_t)length + 128 > MAX_RESPONSE) {
      truncated = 1; break;
    }
    memcpy(output + used, entry, (size_t)length);
    used += (size_t)length;
    first = 0;
  }
  snprintf(output + used, sizeof(output) - used, "],\"unreadable\":%d,\"truncated\":%s}}\n", unreadable, truncated ? "true" : "false");
  fputs(output, stdout);
  free(pids);
  return 0;
}

static int target_operation(const char *op, int pid, uint32_t uid, uint64_t birth, int sig) {
  const char *status = "unknown";
  struct proc_bsdinfo info;
  int found = inspect(pid, &info);
  int missing = !found && (errno == ESRCH || errno == ENOENT);
  if (!strcmp(op, "status")) {
    if (missing) status = "exited";
    else if (found && (born(&info) != birth || info.pbi_uid != uid)) status = "reused";
    else if (found && info.pbi_status == SZOMB) status = "exited";
    else if (found && uid == geteuid() && !protected_pid(pid) && matches(pid) == 1) status = "live";
  } else {
    if (missing || (found && info.pbi_status == SZOMB)) status = "gone";
    else if (protected_pid(pid) || uid != geteuid() || !uid) status = "refused";
    else if (found && (info.pbi_uid != uid || born(&info) != birth)) status = "refused";
    else if (found) {
      int match = matches(pid);
      if (!match) status = "refused";
      else if (match == 1) {
        struct proc_bsdinfo fresh;
        if (!inspect(pid, &fresh)) status = (errno == ESRCH || errno == ENOENT) ? "gone" : "unknown";
        else if (fresh.pbi_uid != uid || born(&fresh) != birth || fresh.pbi_status == SZOMB) status = "refused";
        /* UID/birth checks reduce PID reuse risk but cannot make kill atomic. */
        else if (kill(pid, sig) == 0) status = "sent";
        else if (errno == ESRCH) status = "gone";
      }
    }
  }
  printf("{\"version\":1,\"op\":\"%s\",\"result\":{\"status\":\"%s\"}}\n", op, status);
  return 0;
}

int main(int argc, char **argv) {
  const char *op = argc >= 3 && (!strcmp(argv[2], "scan") || !strcmp(argv[2], "status") || !strcmp(argv[2], "signal")) ? argv[2] : "probe";
  if (argc < 3 || strcmp(argv[1], "v1")) return fail(op, "invalid_request");
  int probe = !strcmp(argv[2], "probe"), scanning = !strcmp(argv[2], "scan");
  int signalling = !strcmp(argv[2], "signal"), status = !strcmp(argv[2], "status");
  if ((probe || scanning) ? argc != 3 : (status ? argc != 6 : (!signalling || argc != 7))) return fail(op, "invalid_request");
#if !defined(__APPLE__) || !defined(__aarch64__)
  return fail(op, "unsupported");
#endif
  if (!geteuid() || getuid() != geteuid()) return fail(op, "unsupported");
  alarm(1);
  if (probe) {
    printf("{\"version\":1,\"op\":\"probe\",\"result\":{\"platform\":\"darwin\",\"arch\":\"arm64\",\"uid\":%u}}\n", geteuid());
    return 0;
  }
  uint64_t pid = 0, uid = 0, birth = 0;
  int sig = 0;
  if (!scanning && (!decimal(argv[3], INT_MAX, &pid) || !pid || !decimal(argv[4], UINT32_MAX, &uid) || !decimal(argv[5], UINT64_MAX, &birth))) return fail(op, "invalid_request");
  if (signalling) {
    if (!strcmp(argv[6], "TERM")) sig = SIGTERM;
    else if (!strcmp(argv[6], "KILL")) sig = SIGKILL;
    else return fail(op, "invalid_request");
  }
  if (!read_cookies()) return fail(op, "invalid_request");
  int mib[] = {CTL_KERN, KERN_ARGMAX}, argmax = 0;
  size_t size = sizeof(argmax);
  if (sysctl(mib, 2, &argmax, &size, NULL, 0) != 0 || argmax < 4096 || argmax > 2097152) return fail(op, "inspection_failed");
  args_capacity = (size_t)argmax;
  args_buffer = malloc(args_capacity);
  if (!args_buffer) return fail(op, "internal");
  int result = scanning ? scan() : target_operation(op, (int)pid, (uint32_t)uid, birth, sig);
  wipe(args_buffer, args_capacity);
  free(args_buffer);
  wipe(run_cookie, sizeof(run_cookie));
  wipe(command_cookie, sizeof(command_cookie));
  return result;
}
