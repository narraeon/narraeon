#include <android/log.h>
#include <fcntl.h>
#include <jni.h>
#include <pthread.h>
#include <sys/stat.h>
#include <unistd.h>

#include <cerrno>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

// Exercise the real JNI entry with a minimal JNI table and a stand-in for Node.
// --wrap injects failures without adding test controls to the app.
extern "C" jint Java_app_narraeon_android_NativeNode_startNode(
    JNIEnv*, jobject, jobjectArray, jobject);

namespace {
const char* fault = "";
const char* arguments[] = {"node", "/a-long/path/to/the/boot/script.js", "3", ""};
const char* environment[] = {"NARRAEON_252_PROBE=changed"};
bool jni_failure = false;
bool stdout_logged = false;
bool stderr_logged = false;
int pipe_calls = 0;
int dup2_calls = 0;
int starts = 0;
int open_fds_at_start = 0;
bool contiguous = false;

bool is_fault(const char* name) { return std::strcmp(fault, name) == 0; }

int count_open_fds() {
  int count = 0;
  for (int fd = 0; fd < 256; ++fd) {
    if (fcntl(fd, F_GETFD) >= 0) ++count;
  }
  return count;
}

bool same_file(const struct stat& before, const struct stat& after) {
  return before.st_dev == after.st_dev && before.st_ino == after.st_ino;
}

bool check(bool ok, const char* message) {
  if (!ok) std::fprintf(stderr, "FAIL [%s] %s\n", fault, message);
  return ok;
}
}  // namespace

extern "C" int __real_pipe(int[2]);
extern "C" int __real_pipe2(int[2], int);
extern "C" int __real_dup2(int, int);
extern "C" int __real_pthread_create(pthread_t*, const pthread_attr_t*, void* (*)(void*), void*);

extern "C" int __wrap_pipe(int ends[2]) {
  ++pipe_calls;
  if (is_fault("pipe") && pipe_calls == 2) {
    errno = EMFILE;
    return -1;
  }
  return __real_pipe(ends);
}
extern "C" int __wrap_pipe2(int ends[2], int flags) {
  ++pipe_calls;
  if (is_fault("pipe") && pipe_calls == 2) {
    errno = EMFILE;
    return -1;
  }
  return __real_pipe2(ends, flags);
}
extern "C" int __wrap_dup2(int from, int to) {
  ++dup2_calls;
  if (is_fault("dup2") && dup2_calls == 2) {
    errno = EIO;
    return -1;
  }
  return __real_dup2(from, to);
}
extern "C" int __wrap_pthread_create(pthread_t* thread, const pthread_attr_t* attr,
                                       void* (*start)(void*), void* arg) {
  if (is_fault("pthread_create")) return EAGAIN;
  return __real_pthread_create(thread, attr, start, arg);
}
extern "C" int __android_log_write(int priority, const char*, const char* message) {
  if (priority == ANDROID_LOG_INFO && std::strstr(message, "probe stdout")) stdout_logged = true;
  if (priority == ANDROID_LOG_ERROR && std::strstr(message, "probe stderr")) stderr_logged = true;
  return 1;
}

namespace node {
int Start(int argc, char** argv) {
  ++starts;
  contiguous = argc == 4 && argv[argc] == nullptr;
  for (int i = 0; i < argc && contiguous; ++i) {
    const size_t size = std::strlen(arguments[i]);
    contiguous = std::strcmp(arguments[i], argv[i]) == 0 &&
        (i + 1 == argc || reinterpret_cast<uintptr_t>(argv[i]) + size + 1 ==
                          reinterpret_cast<uintptr_t>(argv[i + 1]));
    if (size != 0) argv[i][0] = 'x';
  }
  open_fds_at_start = count_open_fds();
  if (is_fault("success")) {
    write(STDOUT_FILENO, "probe stdout\n", 13);
    write(STDERR_FILENO, "probe stderr\n", 13);
  }
  return 17;
}
}  // namespace node

int main(int argc, char** argv) {
  if (argc != 2) return 2;
  fault = argv[1];
  JNINativeInterface table{};
  table.GetArrayLength = [](JNIEnv*, jarray array) -> jsize {
    return array == reinterpret_cast<jarray>(arguments) ? 4 : 1;
  };
  table.GetObjectArrayElement = [](JNIEnv*, jobjectArray array, jsize index) -> jobject {
    auto values = reinterpret_cast<const char* const*>(array);
    return reinterpret_cast<jobject>(const_cast<char*>(values[index]));
  };
  table.GetStringUTFChars = [](JNIEnv*, jstring string, jboolean*) -> const char* {
    return reinterpret_cast<const char*>(string);
  };
  table.ReleaseStringUTFChars = [](JNIEnv*, jstring, const char*) {};
  table.DeleteLocalRef = [](JNIEnv*, jobject) {};
  table.ExceptionCheck = [](JNIEnv*) -> jboolean { return JNI_FALSE; };
  table.FindClass = [](JNIEnv*, const char*) -> jclass { return reinterpret_cast<jclass>(1); };
  table.ThrowNew = [](JNIEnv*, jclass, const char* message) -> jint {
    jni_failure = std::strstr(message, fault) != nullptr;
    return 0;
  };
  JNIEnv env{&table};
  const char* legacy_log = std::getenv("NARRAEON_252_LEGACY");
  std::string log_path = "/data/local/tmp/narraeon-node-stderr-" + std::to_string(getpid());
  jobject diagnostic = legacy_log ? reinterpret_cast<jobject>(environment)
                                  : reinterpret_cast<jobject>(log_path.data());
  if (!legacy_log && is_fault("success")) {
    FILE* previous_log = std::fopen(log_path.c_str(), "w");
    if (!previous_log) return 2;
    std::fputs("previous stderr\n", previous_log);
    std::fclose(previous_log);
  }
  struct stat before[2]{}, after[2]{};
  fstat(STDOUT_FILENO, &before[0]);
  fstat(STDERR_FILENO, &before[1]);
  int open_before = count_open_fds();
  int result = Java_app_narraeon_android_NativeNode_startNode(
      &env, nullptr, reinterpret_cast<jobjectArray>(arguments), diagnostic);
  fstat(STDOUT_FILENO, &after[0]);
  fstat(STDERR_FILENO, &after[1]);
  // Keep the harness report visible even when running against the broken JNI.
  if (legacy_log) {
    bool old_failure = is_fault("success") ? !contiguous && open_fds_at_start >= open_before + 4 &&
                                              std::getenv("NARRAEON_252_PROBE") != nullptr
                                          : starts == 1 && !jni_failure;
    return old_failure ? 1 : 2;
  }
  bool ok = check(same_file(before[0], after[0]) && same_file(before[1], after[1]),
                  "stdout/stderr must be restored") &
            check(count_open_fds() == open_before, "no leaked descriptors");
  if (is_fault("success")) {
    ok &= check(starts == 1 && result == 17, "return Node's result") &
          check(contiguous, "writable mixed-length argv and null sentinel") &
          check(open_fds_at_start == open_before + 5,
                "only two original stream backups, two readers and the stderr file remain") &
          check(stdout_logged && stderr_logged, "both streams reach logcat") &
          check(std::getenv("NARRAEON_252_PROBE") == nullptr, "environment stays unchanged");
    FILE* log = std::fopen(log_path.c_str(), "r");
    char contents[64]{};
    if (log) {
      std::fread(contents, 1, sizeof contents - 1, log);
      std::fclose(log);
    }
    ok &= check(std::strcmp(contents, "previous stderr\nprobe stderr\n") == 0,
                "stderr appends to the existing diagnostic file");
  } else {
    ok &= check(starts == 0 && jni_failure && result < 0, "report setup failure and skip Node");
  }
  unlink(log_path.c_str());
  if (ok) std::printf("PASS [%s]\n", fault);
  return ok ? 0 : 1;
}
