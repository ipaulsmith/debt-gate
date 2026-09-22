#define _GNU_SOURCE
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <unistd.h>

#if defined(__APPLE__)
#include <stdio.h>
static int exchange(const char *left, const char *right) {
  return renamex_np(left, right, RENAME_SWAP);
}
#elif defined(__linux__)
#include <fcntl.h>
#include <linux/fs.h>
#include <sys/syscall.h>
static int exchange(const char *left, const char *right) {
  return syscall(SYS_renameat2, AT_FDCWD, left, AT_FDCWD, right, RENAME_EXCHANGE);
}
#else
#error unsupported race-test platform
#endif

static volatile sig_atomic_t active = 1;
static void stop(int signal_number) {
  (void)signal_number;
  active = 0;
}

int main(int argc, char **argv) {
  if (argc != 4) return 2;
  signal(SIGTERM, stop);
  signal(SIGINT, stop);
  while (active && access(argv[3], F_OK) != 0) usleep(100);
  int swapped = 0;
  while (active) {
    if (exchange(argv[1], argv[2]) != 0) {
      if (errno == ENOENT) continue;
      perror("exchange");
      return 1;
    }
    swapped = !swapped;
    usleep(25);
  }
  if (swapped && exchange(argv[1], argv[2]) != 0) return 1;
  return 0;
}
