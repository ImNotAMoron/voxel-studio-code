# Builds dump_models against an already-built engine (VoxelCoreSrc static lib).
#
#   cmake -S test/preview/dumper -B <tmp>/dumper -DVOXELCORE_ROOT=<repo> \
#         -DCMAKE_TOOLCHAIN_FILE=<vcpkg>/scripts/buildsystems/vcpkg.cmake \
#         -DVCPKG_INSTALLED_DIR=<repo>/build/vcpkg_installed -DVCPKG_MANIFEST_MODE=OFF
#   cmake --build <tmp>/dumper --config Debug
#
# The configuration (Debug/Release) must match the engine build.
cmake_minimum_required(VERSION 3.20)
project(VoxelCoreModelDumper CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(NOT VOXELCORE_ROOT)
    get_filename_component(VOXELCORE_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../../../.." ABSOLUTE)
endif()
if(NOT VOXELCORE_BUILD)
    set(VOXELCORE_BUILD "${VOXELCORE_ROOT}/build")
endif()

find_package(OpenGL REQUIRED)
find_package(GLEW REQUIRED)
find_package(glm REQUIRED)
find_package(ZLIB REQUIRED)
find_package(PNG REQUIRED)
find_package(CURL REQUIRED)
find_package(OpenSSL 3.0 REQUIRED COMPONENTS Crypto)
find_package(glfw3 REQUIRED)
find_package(Freetype REQUIRED)
if(WIN32)
    find_package(OpenAL CONFIG REQUIRED)
    find_package(vorbis REQUIRED)
    set(LUAJIT_LIB "${_VCPKG_INSTALLED_DIR}/${VCPKG_TARGET_TRIPLET}/$<$<CONFIG:Debug>:debug/>lib/lua51.lib")
    set(SRC_LIB "${VOXELCORE_BUILD}/src/$<CONFIG>/VoxelCoreSrc.lib")
else()
    find_package(OpenAL REQUIRED)
    find_package(PkgConfig)
    pkg_check_modules(luajit REQUIRED IMPORTED_TARGET luajit)
    pkg_check_modules(vorbis REQUIRED IMPORTED_TARGET vorbis)
    pkg_check_modules(vorbisfile REQUIRED IMPORTED_TARGET vorbisfile)
    set(LUAJIT_LIB PkgConfig::luajit PkgConfig::vorbis PkgConfig::vorbisfile)
    set(SRC_LIB "${VOXELCORE_BUILD}/src/libVoxelCoreSrc.a")
endif()

add_executable(dump_models dump_models.cpp)
target_include_directories(dump_models PRIVATE "${VOXELCORE_ROOT}/src")
if(MSVC)
    target_compile_options(dump_models PRIVATE /utf-8 /D_DISABLE_CONSTEXPR_MUTEX_CONSTRUCTOR)
endif()
target_link_libraries(
    dump_models
    PRIVATE "${SRC_LIB}"
            glfw
            OpenGL::GL
            GLEW::GLEW
            ZLIB::ZLIB
            PNG::PNG
            CURL::libcurl
            OpenSSL::Crypto
            $<IF:$<TARGET_EXISTS:OpenAL::OpenAL>,OpenAL::OpenAL,${OPENAL_LIBRARY}>
            $<$<TARGET_EXISTS:Vorbis::vorbis>:Vorbis::vorbis>
            $<$<TARGET_EXISTS:Vorbis::vorbisfile>:Vorbis::vorbisfile>
            Freetype::Freetype
            glm::glm
            ${LUAJIT_LIB}
)
