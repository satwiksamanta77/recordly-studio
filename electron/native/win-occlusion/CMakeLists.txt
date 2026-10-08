cmake_minimum_required(VERSION 3.20)
project(win-occlusion LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_executable(win-occlusion
  win-occlusion.cpp
)

target_compile_options(win-occlusion PRIVATE /EHsc /W3 /utf-8)

target_link_libraries(win-occlusion PRIVATE
  dwmapi
  user32
  kernel32
)
