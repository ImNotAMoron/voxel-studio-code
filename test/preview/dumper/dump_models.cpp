// Golden-data dumper for the preview mesh builders (test/preview/golden.test.ts).
//
// The engine's Lua API cannot expose model vertex data (assets.parse_model
// stores into Assets, which do not exist in headless mode, and nothing reads
// meshes back), so this tool links the engine's own VoxelCoreSrc library and
// calls the real loaders: vcm::parse, obj::parse and vec3::load.
//
// Usage: dump_models <out.json> <model files...>
// Output: { "<path as given>": { kind, parts|models, bones? } }
#include <cstdio>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>

#include "animation/rigging.hpp"
#include "coders/obj.hpp"
#include "coders/vcm.hpp"
#include "coders/vec3.hpp"
#include "graphics/commons/Model.hpp"
#include "util/Buffer.hpp"

static std::string num(float v) {
    char buf[64];
    std::snprintf(buf, sizeof(buf), "%.9g", v);
    std::string s = buf;
    if (s == "nan" || s == "-nan" || s == "inf" || s == "-inf") {
        return "null";
    }
    return s;
}

static std::string quote(const std::string& s) {
    std::string out = "\"";
    for (char c : s) {
        if (c == '"' || c == '\\') {
            out += '\\';
            out += c;
        } else if (c == '\n') {
            out += "\\n";
        } else if (static_cast<unsigned char>(c) < 0x20) {
            out += ' ';
        } else {
            out += c;
        }
    }
    return out + "\"";
}

static void write_model(std::ostream& out, const model::Model& model) {
    out << "[";
    bool firstMesh = true;
    for (const auto& mesh : model.meshes) {
        if (!firstMesh) out << ",";
        firstMesh = false;
        out << "\n{\"texture\":" << quote(mesh.texture)
            << ",\"shading\":" << (mesh.shading ? "true" : "false")
            << ",\"vertices\":[";
        bool first = true;
        for (const auto& v : mesh.vertices) {
            if (!first) out << ",";
            first = false;
            out << num(v.coord.x) << "," << num(v.coord.y) << ","
                << num(v.coord.z) << "," << num(v.uv.x) << "," << num(v.uv.y)
                << "," << num(v.normal.x) << "," << num(v.normal.y) << ","
                << num(v.normal.z);
        }
        out << "]}";
    }
    out << "]";
}

static void write_bones(
    std::ostream& out, const rigging::Bone& bone, int parent, bool& first
) {
    if (!first) out << ",";
    first = false;
    auto offset = bone.getOffset();
    out << "\n{\"name\":" << quote(bone.getName())
        << ",\"index\":" << bone.getIndex() << ",\"parent\":" << parent
        << ",\"offset\":[" << num(offset.x) << "," << num(offset.y) << ","
        << num(offset.z) << "]}";
    for (const auto& sub : bone.getBones()) {
        write_bones(out, *sub, static_cast<int>(bone.getIndex()), first);
    }
}

static std::string read_file(const std::string& path) {
    std::ifstream file(path, std::ios::binary);
    if (!file) throw std::runtime_error("cannot open " + path);
    std::stringstream ss;
    ss << file.rdbuf();
    return ss.str();
}

static std::string extension(const std::string& path) {
    auto dot = path.rfind('.');
    return dot == std::string::npos ? "" : path.substr(dot);
}

int main(int argc, char** argv) {
    if (argc < 3) {
        std::cerr << "usage: dump_models <out.json> <files...>\n";
        return 1;
    }
    std::ofstream out(argv[1], std::ios::binary);
    out << "{";
    for (int i = 2; i < argc; i++) {
        std::string path = argv[i];
        std::string ext = extension(path);
        if (i > 2) out << ",";
        out << "\n" << quote(path) << ":";
        try {
            std::string text = read_file(path);
            std::stringstream entry;
            if (ext == ".vcm" || ext == ".xml") {
                auto vcmModel = vcm::parse(path, text, ext == ".xml");
                entry << "{\"kind\":\"vcm\",\"parts\":{";
                bool first = true;
                for (const auto& [name, model] : vcmModel.parts) {
                    if (!first) entry << ",";
                    first = false;
                    entry << "\n" << quote(name) << ":";
                    write_model(entry, model);
                }
                entry << "},\"bones\":[";
                bool firstBone = true;
                write_bones(entry, *vcmModel.skeleton->getRoot(), -1, firstBone);
                entry << "]}";
            } else if (ext == ".obj") {
                auto model = obj::parse(path, text);
                entry << "{\"kind\":\"obj\",\"meshes\":";
                write_model(entry, *model);
                entry << "}";
            } else if (ext == ".vec3") {
                util::Buffer<ubyte> bytes(
                    reinterpret_cast<const ubyte*>(text.data()), text.size()
                );
                auto file = vec3::load(path, bytes);
                entry << "{\"kind\":\"vec3\",\"materials\":[";
                for (size_t m = 0; m < file.materials.size(); m++) {
                    if (m) entry << ",";
                    entry << "{\"flags\":" << file.materials[m].flags
                          << ",\"name\":" << quote(file.materials[m].name)
                          << "}";
                }
                entry << "],\"models\":{";
                bool first = true;
                for (const auto& [name, model] : file.models) {
                    if (!first) entry << ",";
                    first = false;
                    entry << "\n" << quote(name) << ":{\"origin\":["
                          << num(model.origin.x) << "," << num(model.origin.y)
                          << "," << num(model.origin.z) << "],\"meshes\":";
                    write_model(entry, model.model);
                    entry << "}";
                }
                entry << "}}";
            } else {
                throw std::runtime_error("unknown extension " + ext);
            }
            out << entry.str();
        } catch (const std::exception& err) {
            out << "{\"error\":" << quote(err.what()) << "}";
        }
    }
    out << "\n}\n";
    return 0;
}
