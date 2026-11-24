#include <android/log.h>
#include <fcntl.h>
#include <jni.h>
#include <poll.h>
#include <pthread.h>
#include <sys/stat.h>
#include <unistd.h>

#include <cerrno>
#include <cstdio>
#include <cstring>
#include <memory>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include "node.h"

namespace {

constexpr char kLogTag[] = "NARRAEON-NODE";
constexpr off_t kStderrLogLimit = 1024 * 1024;

class Fd {
 public:
  Fd() = default;
  Fd(const Fd&) = delete;
  Fd& operator=(const Fd&) = delete;
  ~Fd() { reset(); }

  int get() const { return fd_; }
  void reset(int fd = -1) {
    if (fd_ >= 0) close(fd_);
    fd_ = fd;
  }

 private:
  int fd_ = -1;
};

[[noreturn]] void fail(const char* operation, int error) {
  throw std::runtime_error(std::string(operation) + " failed (error " +
                           std::to_string(error) + ")");
}

void log_error(const char* operation, int error) {
  __android_log_print(ANDROID_LOG_ERROR, kLogTag, "%s failed (error %d)", operation, error);
}

struct LogStream {
  int target;
  int priority;
  int saved_flags = 0;
  bool redirected = false;
  Fd original;
  Fd reader;
  Fd writer;

  void save_original() {
    saved_flags = fcntl(target, F_GETFD);
    if (saved_flags == -1) fail("fcntl(F_GETFD) for log stream", errno);
    original.reset(fcntl(target, F_DUPFD_CLOEXEC, STDERR_FILENO + 1));
    if (original.get() == -1) fail("fcntl(F_DUPFD_CLOEXEC) for log stream", errno);
  }

  void open_pipe() {
    int pipe_fds[2];
    if (pipe2(pipe_fds, O_CLOEXEC) == -1) fail("pipe2 for log stream", errno);
    reader.reset(pipe_fds[0]);
    writer.reset(pipe_fds[1]);
  }

  void redirect() {
    int result;
    do {
      result = dup2(writer.get(), target);
    } while (result == -1 && errno == EINTR);
    if (result == -1) fail("dup2 for log stream", errno);
    redirected = true;
    writer.reset();
  }

  void restore() {
    if (!redirected) return;
    int result;
    do {
      result = dup3(original.get(), target, saved_flags & FD_CLOEXEC ? O_CLOEXEC : 0);
    } while (result == -1 && (errno == EINTR || errno == EBUSY));
    if (result == -1) {
      log_error("dup3 restoring log stream", errno);
      close(target);
    }
  }
};

class NodeLogRedirect {
 public:
  explicit NodeLogRedirect(std::string stderr_path)
      : stderr_path_(std::move(stderr_path)), rotated_path_(stderr_path_ + ".1") {}

  void start() {
    // Save both descriptors before opening pipes, so a closed stdio fd cannot be
    // reused by a pipe and then mistaken for the original stream.
    for (auto& stream : streams_) stream.save_original();
    for (auto& stream : streams_) stream.open_pipe();
    open_stderr_log();
    const int error = pthread_create(&pump_, nullptr, pump_logs, this);
    if (error != 0) fail("pthread_create for log pump", error);
    pump_started_ = true;
    for (auto& stream : streams_) stream.redirect();
  }

  ~NodeLogRedirect() {
    if (pump_started_) {
      std::fflush(stdout);
      std::fflush(stderr);
    }
    // Closing the last pipe writers lets the reader drain and finish on EOF.
    for (auto& stream : streams_) {
      stream.restore();
      stream.writer.reset();
    }
    if (pump_started_) pthread_join(pump_, nullptr);
  }

 private:
  static void* pump_logs(void* arg) {
    static_cast<NodeLogRedirect*>(arg)->drain();
    return nullptr;
  }

  void drain() {
    pollfd pipes[] = {{streams_[0].reader.get(), POLLIN, 0},
                      {streams_[1].reader.get(), POLLIN, 0}};
    while (pipes[0].fd >= 0 || pipes[1].fd >= 0) {
      if (poll(pipes, 2, -1) == -1) {
        if (errno == EINTR) continue;
        log_error("poll for log pump", errno);
        return;
      }
      for (size_t i = 0; i < 2; ++i) {
        if (pipes[i].revents == 0) continue;
        char buf[2048];
        const ssize_t size = read(pipes[i].fd, buf, sizeof buf - 1);
        if (size > 0) {
          if (streams_[i].target == STDERR_FILENO) append_stderr_log(buf, size);
          buf[buf[size - 1] == '\n' ? size - 1 : size] = '\0';
          __android_log_write(streams_[i].priority, kLogTag, buf);
        } else if (size == 0) {
          pipes[i].fd = -1;
        } else if (errno != EINTR) {
          log_error("read for log pump", errno);
          pipes[i].fd = -1;
        }
      }
    }
  }

  void open_stderr_log() {
    stderr_log_.reset(open(stderr_path_.c_str(), O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, 0600));
    if (stderr_log_.get() == -1) log_error("open node-stderr.log", errno);
  }

  void append_stderr_log(const char* text, size_t size) {
    if (stderr_log_.get() == -1) return;
    struct stat info{};
    if (fstat(stderr_log_.get(), &info) == 0 && info.st_size > kStderrLogLimit) {
      if (std::rename(stderr_path_.c_str(), rotated_path_.c_str()) == 0) {
        open_stderr_log();
        if (stderr_log_.get() == -1) return;
      } else {
        log_error("rotate node-stderr.log", errno);
      }
    }
    while (size > 0) {
      const ssize_t written = write(stderr_log_.get(), text, size);
      if (written == -1 && errno == EINTR) continue;
      if (written <= 0) {
        log_error("write node-stderr.log", written == -1 ? errno : EIO);
        stderr_log_.reset();
        return;
      }
      text += written;
      size -= written;
    }
  }

  LogStream streams_[2]{{STDOUT_FILENO, ANDROID_LOG_INFO}, {STDERR_FILENO, ANDROID_LOG_ERROR}};
  std::string stderr_path_;
  std::string rotated_path_;
  Fd stderr_log_;
  pthread_t pump_{};
  bool pump_started_ = false;
};

std::string copy_string(JNIEnv* env, jstring string) {
  if (!string) throw std::invalid_argument("missing Node startup string");
  const auto release = [env, string](const char* chars) {
    env->ReleaseStringUTFChars(string, chars);
  };
  std::unique_ptr<const char, decltype(release)> chars(env->GetStringUTFChars(string, nullptr), release);
  if (!chars) throw std::runtime_error("could not read Node startup string");
  return chars.get();
}

}  // namespace

extern "C" JNIEXPORT jint JNICALL
Java_app_narraeon_android_NativeNode_startNode(JNIEnv* env, jclass /* type */,
                                              jobjectArray arguments,
                                              jstring stderr_path) {
  try {
    const jsize argc = env->GetArrayLength(arguments);
    if (argc == 0) throw std::invalid_argument("missing Node arguments");
    std::vector<char> storage;
    std::vector<size_t> offsets;
    offsets.reserve(argc);
    for (jsize i = 0; i < argc; ++i) {
      auto arg = static_cast<jstring>(env->GetObjectArrayElement(arguments, i));
      const std::string value = copy_string(env, arg);
      env->DeleteLocalRef(arg);
      offsets.push_back(storage.size());
      storage.insert(storage.end(), value.c_str(), value.c_str() + value.size() + 1);
    }
    // libuv uses this layout for process.title. Compute pointers only once the
    // writable storage is complete, and keep it alive across node::Start.
    std::vector<char*> argv;
    argv.reserve(offsets.size() + 1);
    for (size_t offset : offsets) argv.push_back(storage.data() + offset);
    argv.push_back(nullptr);

    NodeLogRedirect logs(copy_string(env, stderr_path));
    logs.start();
    return node::Start(argc, argv.data());
  } catch (const std::exception& error) {
    __android_log_write(ANDROID_LOG_ERROR, kLogTag, error.what());
    if (!env->ExceptionCheck()) {
      jclass exception = env->FindClass("java/lang/IllegalStateException");
      if (exception) env->ThrowNew(exception, error.what());
    }
    return -1;
  }
}
