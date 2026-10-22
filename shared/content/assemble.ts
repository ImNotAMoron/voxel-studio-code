// Pack load order, ported from PacksManager::assemble / resolve_dependencies
// (src/content/PacksManager.cpp). Pure.
//
// The engine processes a queue: a pack is added once all its found
// dependencies are added; unresolved packs move to a second queue. From the
// second pass on, weak dependencies that aren't added yet are ignored. A pass
// that adds nothing (after the first) is a circular dependency. Missing
// required dependencies and unmet versions throw. `core` is loaded before
// every pack and isn't part of this list.

import { versionSatisfies, type DependencyInfo, type DependencyLevel } from "./pack";

export interface AssemblePack {
    id: string;
    version?: string;
    dependencyInfo: DependencyInfo[];
}

export interface AssembleResult {
    /** Load order (dependencies first). Partial when `error` is set. */
    order: string[];
    /** The engine's error text (contentpack_error), if assembling fails. */
    error?: { pack: string; message: string };
}

function versionOk(dep: DependencyInfo, pack: AssemblePack): boolean {
    return versionSatisfies(dep, pack.version ?? "0.0");
}

export function assemblePacks(names: string[], packs: Map<string, AssemblePack>): AssembleResult {
    const allNames = [...names];
    const added: string[] = [];
    let queue: AssemblePack[] = [];
    for (const name of names) {
        const pack = packs.get(name);
        if (!pack) return { order: added, error: { pack: name, message: "pack not found" } };
        queue.push(pack);
    }
    let resolveWeaks = false;
    try {
        while (queue.length > 0) {
            let addedInIteration = 0;
            const next: AssemblePack[] = [];
            while (queue.length > 0) {
                const pack = queue.shift()!;
                if (resolveDependencies(pack, packs, allNames, added, queue, resolveWeaks)) {
                    if (added.includes(pack.id)) throw { pack: pack.id, message: "pack duplication" };
                    added.push(pack.id);
                    addedInIteration++;
                } else {
                    next.push(pack);
                }
            }
            queue = next;
            if (addedInIteration === 0 && resolveWeaks) {
                const last = queue[queue.length - 1];
                throw { pack: last.id, message: `circular dependency: ${last.id} <- ${queue.map((p) => p.id).join(" <- ")}` };
            }
            resolveWeaks = true;
        }
    } catch (err) {
        if (err && typeof err === "object" && "message" in err) return { order: added, error: err as AssembleResult["error"] };
        throw err;
    }
    return { order: added };
}

function resolveDependencies(
    pack: AssemblePack,
    packs: Map<string, AssemblePack>,
    allNames: string[],
    added: string[],
    queue: AssemblePack[],
    resolveWeaks: boolean
): boolean {
    let satisfied = true;
    for (const dep of pack.dependencyInfo) {
        if (!dep.id) continue;
        if (added.includes(dep.id)) continue;
        const found = packs.get(dep.id);
        if (!found && dep.level === "required") {
            throw { pack: dep.id, message: `dependency of '${pack.id}'` };
        }
        if (!found) continue;
        if (resolveWeaks && dep.level === "weak") continue;
        if (!versionOk(dep, found)) {
            throw { pack: dep.id, message: `does not meet required version '${dep.op}${dep.version}' of '${pack.id}'` };
        }
        if (!allNames.includes(dep.id) && dep.level !== "weak") {
            allNames.push(dep.id);
            queue.push(found);
        }
        satisfied = false;
    }
    return satisfied;
}

/** Status of one declared dependency, for display. */
export type DependencyStatus = "ok" | "missing" | "ignored" | "version";

export function dependencyStatus(dep: DependencyInfo, packs: Map<string, AssemblePack>): DependencyStatus {
    const found = packs.get(dep.id);
    if (!found) return dep.level === ("required" satisfies DependencyLevel) ? "missing" : "ignored";
    return versionOk(dep, found) ? "ok" : "version";
}
