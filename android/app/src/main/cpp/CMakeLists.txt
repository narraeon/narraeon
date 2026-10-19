# Adapted from digidem/nodejs-mobile-react-native android/CMakeLists.txt.
cmake_minimum_required(VERSION 3.22)

project(narraeon-native LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# libnode is extracted by android/scripts/fetch-libnode.sh into android/app/libnode/.
set(LIBNODE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../../libnode")

add_library(narraeon-native SHARED native-lib.cpp)

target_include_directories(narraeon-native PRIVATE "${LIBNODE_DIR}/include/node")

add_library(libnode SHARED IMPORTED)
set_target_properties(libnode PROPERTIES
  IMPORTED_LOCATION "${LIBNODE_DIR}/bin/${ANDROID_ABI}/libnode.so")

find_library(log-lib log)

target_link_libraries(narraeon-native libnode ${log-lib})

# 16 KB ELF page alignment for NDK r26 and lower.
target_link_options(narraeon-native PRIVATE "-Wl,-z,max-page-size=16384")
