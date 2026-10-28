#include <mach/mach.h>
#include <servers/bootstrap.h>
#include <stdio.h>
#include <unistd.h>

int main(void) {
  alarm(1);
  const char *services[] = {"com.apple.securityd.xpc", "com.apple.SecurityServer"};
  printf("{\"version\":1,\"lookups\":[");
  for (unsigned int i = 0; i < sizeof(services) / sizeof(services[0]); i++) {
    mach_port_t port = MACH_PORT_NULL;
    kern_return_t kr = bootstrap_look_up(bootstrap_port, services[i], &port);
    if (kr == KERN_SUCCESS) mach_port_deallocate(mach_task_self(), port);
    printf("%s{\"service\":\"%s\",\"kr\":%d}", i ? "," : "", services[i], kr);
  }
  puts("]}");
  return 0;
}
