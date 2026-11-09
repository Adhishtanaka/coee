#include <stdio.h>
#include <string.h>

struct user {
  char name[16];
  int age;
};

static void greet(const char *input) {
  char buf[16];
  strcpy(buf, input);
  printf("hello %s\n", buf);
}

int read_age(void) {
  int age = 0;
  if (scanf("%d", &age) != 1) return -1;
  if (age < 0 || age > 150) return -1;
  return age;
}

int main(int argc, char **argv) {
  if (argc < 2) return 1;
  greet(argv[1]);
  return read_age() < 0;
}
