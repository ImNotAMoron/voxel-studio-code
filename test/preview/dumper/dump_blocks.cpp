// Golden-data dumper for the block / entity preview builders
// (test/preview/block-golden.test.ts). Links the engine's VoxelCoreSrc and
// uses the engine's own code for what can run without a GL context or a
// loaded Content:
// - BlockRotProfile constants (src/voxels/Block.cpp) and CoordSystem::transform
//   + AABB::fix, exactly as ContentBuilder::build precomputes rt.hitboxes;
// - ModelsGenerator::loadCustomBlockModel for `model-primitives` (an empty
//   Assets makes every texture region the full 0..1 range);
// - rigging::SkeletonConfig::parse + SkeletonConfig::update (rest pose,
//   identity rotation, position (0.5, 0.5, 0.5)) for skeleton JSON files.
// BlocksRenderer geometry needs Chunks/ContentGfxCache and isn't dumped; the
// unit tests derive it from the C++ by hand.
//
// Usage: dump_blocks <out.json> <block or skeleton json files...>
// A file under a `skeletons` folder is treated as a skeleton.
#include <cstdio>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>

#include "animation/rigging.hpp"
#include "assets/Assets.hpp"
#include "coders/json.hpp"
#include "data/dv.hpp"
#include "graphics/commons/Model.hpp"
#include "graphics/render/ModelsGenerator.hpp"
#include "maths/aabb.hpp"
#include "util/ObjectsKeeper.hpp"
#include "voxels/Block.hpp"

static std::string num(float v) {
    char buf[64];
    std::snprintf(buf, sizeof(buf), "%.9g", v);
    return buf;
}

static std::string quote(const std::string& s) {
    std::string out = "\"";
    for (char c : s) {
        if (c == '"' || c == '\\') out += '\\';
        out += c;
    }
    return out + "\"";
}

static std::string vec(const glm::vec3& v) {
    return "[" + num(v.x) + "," + num(v.y) + "," + num(v.z) + "]";
}

static std::string ivec(const glm::ivec3& v) {
    return "[" + std::to_string(v.x) + "," + std::to_string(v.y) + "," + std::to_string(v.z) + "]";
}

static void write_profile(std::ostream& out, const BlockRotProfile& profile) {
    out << quote(profile.name) << ":[";
    for (int i = 0; i < profile.variantsCount; i++) {
        const auto& cs = profile.variants[i];
        if (i) out << ",";
        out << "{\"axes\":[" << ivec(cs.axes[0]) << "," << ivec(cs.axes[1]) << ","
            << ivec(cs.axes[2]) << "],\"fix\":" << ivec(cs.fix) << "}";
    }
    out << "]";
}

static const BlockRotProfile* profile_by_name(const std::string& name) {
    for (const auto* p : {&BlockRotProfile::PIPE, &BlockRotProfile::PANE,
                          &BlockRotProfile::STAIRS, &BlockRotProfile::LADDER}) {
        if (p->name == name) return p;
    }
    return nullptr;
}

static void write_model(std::ostream& out, const model::Model& model) {
    out << "[";
    bool firstMesh = true;
    for (const auto& mesh : model.meshes) {
        if (!firstMesh) out << ",";
        firstMesh = false;
        out << "{\"texture\":" << quote(mesh.texture) << ",\"shading\":"
            << (mesh.shading ? "true" : "false") << ",\"vertices\":[";
        bool first = true;
        for (const auto& v : mesh.vertices) {
            if (!first) out << ",";
            first = false;
            out << num(v.coord.x) << "," << num(v.coord.y) << "," << num(v.coord.z)
                << "," << num(v.uv.x) << "," << num(v.uv.y) << ","
                << num(v.normal.x) << "," << num(v.normal.y) << "," << num(v.normal.z);
        }
        out << "]}";
    }
    out << "]";
}

// BlockLoader.cpp hitbox / hitboxes parsing ([x, y, z, w, h, d])
static std::vector<AABB> read_hitboxes(const dv::value& root) {
    auto read = [](const dv::value& box) {
        AABB aabb;
        aabb.a = glm::vec3(box[0].asNumber(), box[1].asNumber(), box[2].asNumber());
        aabb.b = glm::vec3(box[3].asNumber(), box[4].asNumber(), box[5].asNumber());
        aabb.b += aabb.a;
        return aabb;
    };
    std::vector<AABB> boxes {AABB()};
    if (root.has("hitboxes")) {
        boxes.clear();
        for (const auto& box : root["hitboxes"]) boxes.push_back(read(box));
    } else if (root.has("hitbox")) {
        boxes = {read(root["hitbox"])};
    }
    return boxes;
}

static std::string dump_block(const std::string& path, const std::string& text) {
    auto root = json::parse(path, text);
    std::stringstream out;
    auto hitboxes = read_hitboxes(root);
    out << "{\"kind\":\"block\",\"hitboxes\":[";
    for (size_t i = 0; i < hitboxes.size(); i++) {
        if (i) out << ",";
        out << "[" << vec(hitboxes[i].a) << "," << vec(hitboxes[i].b) << "]";
    }
    out << "]";
    std::string rotation;
    root.at("rotation").get(rotation);
    if (auto profile = profile_by_name(rotation)) {
        out << ",\"rotation\":" << quote(rotation) << ",\"rotated\":[";
        for (int r = 0; r < profile->variantsCount; r++) {
            if (r) out << ",";
            out << "[";
            for (size_t i = 0; i < hitboxes.size(); i++) {
                AABB aabb = hitboxes[i];
                // ContentBuilder::build
                profile->variants[r].transform(aabb);
                aabb.fix();
                if (i) out << ",";
                out << "[" << vec(aabb.a) << "," << vec(aabb.b) << "]";
            }
            out << "]";
        }
        out << "]";
    }
    if (root.has("model-primitives")) {
        util::ObjectsKeeper keeper;
        Assets assets(&keeper);
        bool shadeless = false;
        root.at("shadeless").get(shadeless);
        auto model = ModelsGenerator::loadCustomBlockModel(
            root["model-primitives"], assets, !shadeless
        );
        out << ",\"primitives\":";
        write_model(out, model);
    }
    out << "}";
    return out.str();
}

static std::string dump_skeleton(const std::string& path, const std::string& text) {
    std::shared_ptr<rigging::SkeletonConfig> config =
        rigging::SkeletonConfig::parse(text, path, "skeleton");
    auto skeleton = config->instance();
    config->update(skeleton, glm::mat3(1.0f), glm::vec3(0.5f), glm::vec3(1.0f));
    std::stringstream out;
    out << "{\"kind\":\"skeleton\",\"bones\":[";
    const auto& bones = config->getBones();
    for (size_t i = 0; i < bones.size(); i++) {
        if (i) out << ",";
        const auto& m = skeleton.calculated.matrices[i];
        out << "{\"index\":" << bones[i]->getIndex() << ",\"name\":"
            << quote(bones[i]->getName()) << ",\"model\":"
            << quote(bones[i]->model.name) << ",\"position\":"
            << vec(glm::vec3(m * glm::vec4(0, 0, 0, 1))) << "}";
    }
    out << "]}";
    return out.str();
}

int main(int argc, char** argv) {
    if (argc < 2) {
        std::cerr << "usage: dump_blocks <out.json> <files...>\n";
        return 1;
    }
    std::ofstream out(argv[1], std::ios::binary);
    out << "{\n\"profiles\":{";
    bool firstProfile = true;
    for (const auto* p : {&BlockRotProfile::PIPE, &BlockRotProfile::PANE,
                          &BlockRotProfile::STAIRS, &BlockRotProfile::LADDER}) {
        if (!firstProfile) out << ",";
        firstProfile = false;
        out << "\n";
        write_profile(out, *p);
    }
    out << "},\n\"files\":{";
    for (int i = 2; i < argc; i++) {
        std::string path = argv[i];
        for (auto& c : path) if (c == '\\') c = '/';
        if (i > 2) out << ",";
        out << "\n" << quote(path) << ":";
        try {
            std::ifstream file(argv[i], std::ios::binary);
            std::stringstream ss;
            ss << file.rdbuf();
            bool skeleton = path.find("/skeletons/") != std::string::npos;
            out << (skeleton ? dump_skeleton(path, ss.str()) : dump_block(path, ss.str()));
        } catch (const std::exception& err) {
            out << "{\"error\":" << quote(err.what()) << "}";
        }
    }
    out << "\n}}\n";
    return 0;
}
