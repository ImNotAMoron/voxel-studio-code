// Cursor ↔ element mapping for the preview's selection sync.

import { type Span, type VcmElement } from "../vcm/parser";

/** Innermost element whose span contains `offset` (inclusive end). */
export function elementAt(elements: VcmElement[], offset: number): VcmElement | undefined {
    for (const element of elements) {
        if (element.span.start <= offset && offset <= element.span.end) {
            return elementAt(element.children, offset) ?? element;
        }
    }
    return undefined;
}

/** Spans to highlight for a set of cursor offsets. */
export function highlightSpans(elements: VcmElement[], offsets: number[]): Span[] {
    const spans: Span[] = [];
    for (const offset of offsets) {
        const element = elementAt(elements, offset);
        if (element && !spans.some((s) => s.start === element.span.start && s.end === element.span.end)) {
            spans.push(element.span);
        }
    }
    return spans;
}
