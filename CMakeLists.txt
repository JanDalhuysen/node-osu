cmake_minimum_required(VERSION 3.10)

project(node-osu)

if(CMAKE_SYSTEM_NAME STREQUAL "Windows")
include_directories("${CMAKE_CURRENT_LIST_DIR}/include/")
link_directories("${CMAKE_CURRENT_LIST_DIR}/lib/")
endif()

if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
include_directories("/usr/local/include/aubio")
link_directories("/usr/local/lib")
endif()

add_executable(wav_to_beats "${CMAKE_CURRENT_LIST_DIR}/wav_to_beats.cpp")

if(CMAKE_SYSTEM_NAME STREQUAL "Windows")
target_link_libraries(wav_to_beats aubio -static)
endif()

if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
target_link_libraries(wav_to_beats aubio)
endif()
