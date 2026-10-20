#include <fcntl.h>
#include <jni.h>
#include <pthread.h>
#include <sys/stat.h>
#include <unistd.h>

#include <cstdio>

#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include <android/log.h>

#include "node.h"

// Adapted from digidem/nodejs-mobile-react-native android/src/main/cpp/native-lib.cpp.
// Differences: no rn-bridge (the Kotlin side talks to the WebView over HTTP), and the
// environment is passed as "KEY=VALUE" entries and applied with setenv before node::Start.

namespace {

const char* kLogTag = "NARRAEON-NODE";

int pipe_stdout[2];
int pipe_stderr[2];

// Node stderr is also appended to the file named by NARRAEON_STDERR_LOG, so fatal
// errors that end the process (V8 out of memory, aborts) survive for log export
// after logcat has rotated. The file is renamed to "<path>.1" once it passes
// kStderrLogLimit bytes. Only the stderr pump thread touches these.
constexpr off_t kStderrLogLimit = 1024 * 1024;
std::string stderr_log_path;
int stderr_log_fd = -1;

void open_stderr_log() {
  stderr_log_fd = open(stderr_log_path.c_str(),
                       O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, 0600);
}

void append_stderr_log(const char* text, size_t size) {
  if (stderr_log_fd < 0) return;
  struct stat info {};
  if (fstat(stderr_log_fd, &info) == 0 && info.st_size > kStderrLogLimit) {
    close(stderr_log_fd);
    std::rename(stderr_log_path.c_str(), (stderr_log_path + ".1").c_str());
    open_stderr_log();
    if (stderr_log_fd < 0) return;
  }
  write(stderr_log_fd, text, size);
  write(stderr_log_fd, "\n", 1);
}

void* pump_pipe(void* arg) {
  const int fd = *static_cast<int*>(arg);
  const int priority =
      fd == pipe_stdout[0] ? ANDROID_LOG_INFO : ANDROID_LOG_ERROR;
  char buf[2048];
  ssize_t size;
  while ((size = read(fd, buf, sizeof buf - 1)) > 0) {
    if (buf[size - 1] == '\n') --size;
    buf[size] = 0;
    __android_log_write(priority, kLogTag, buf);
    if (fd == pipe_stderr[0]) append_stderr_log(buf, static_cast<size_t>(size));
  }
  return nullptr;
}

// Redirects stdout/stderr into logcat. The fds are kept in static storage so the
// reader threads can use them for the life of the process.
void redirect_output_to_logcat() {
  if (const char* path = std::getenv("NARRAEON_STDERR_LOG")) {
    stderr_log_path = path;
    open_stderr_log();
  }
  setvbuf(stdout, nullptr, _IONBF, 0);
  setvbuf(stderr, nullptr, _IONBF, 0);
  pipe(pipe_stdout);
  dup2(pipe_stdout[1], STDOUT_FILENO);
  pipe(pipe_stderr);
  dup2(pipe_stderr[1], STDERR_FILENO);

  static int stdout_fd = pipe_stdout[0];
  static int stderr_fd = pipe_stderr[0];
  pthread_t out_thread;
  pthread_t err_thread;
  if (pthread_create(&out_thread, nullptr, pump_pipe, &stdout_fd) == 0)
    pthread_detach(out_thread);
  if (pthread_create(&err_thread, nullptr, pump_pipe, &stderr_fd) == 0)
    pthread_detach(err_thread);
}

}  // namespace

extern "C" JNIEXPORT jint JNICALL
Java_app_narraeon_android_NativeNode_startNode(JNIEnv* env, jobject /* thiz */,
                                               jobjectArray arguments,
                                               jobjectArray environment) {
  const jsize env_count = env->GetArrayLength(environment);
  for (jsize i = 0; i < env_count; i++) {
    auto entry = static_cast<jstring>(env->GetObjectArrayElement(environment, i));
    const char* chars = env->GetStringUTFChars(entry, nullptr);
    const char* eq = std::strchr(chars, '=');
    if (eq != nullptr) {
      std::string key(chars, eq - chars);
      setenv(key.c_str(), eq + 1, 1);
    }
    env->ReleaseStringUTFChars(entry, chars);
    env->DeleteLocalRef(entry);
  }

  // node::Start requires argv entries in contiguous memory, so copy them into one
  // buffer and point argv into it.
  const jsize argc = env->GetArrayLength(arguments);
  std::vector<std::string> owned;
  owned.reserve(argc);
  for (jsize i = 0; i < argc; i++) {
    auto arg = static_cast<jstring>(env->GetObjectArrayElement(arguments, i));
    const char* chars = env->GetStringUTFChars(arg, nullptr);
    owned.emplace_back(chars);
    env->ReleaseStringUTFChars(arg, chars);
    env->DeleteLocalRef(arg);
  }
  std::vector<char*> argv;
  argv.reserve(argc + 1);
  for (auto& s : owned) argv.push_back(s.data());
  argv.push_back(nullptr);

  redirect_output_to_logcat();
  return static_cast<jint>(node::Start(static_cast<int>(argc), argv.data()));
}
