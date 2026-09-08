import { DocumentError } from "../errors";
import { walkXml, type XmlSpan } from "../xml";

export interface XmlElement extends XmlSpan {
  name: string;
  contentStart: number;
  contentEnd: number;
  depth: number;
  attributes: string;
  text: string;
  nested: boolean;
}

/** Locate complete elements without serializing unrelated XML or matching markup in comments. */
export function xmlElements(xml: string, select: (name: string) => boolean): XmlElement[] {
  const elements: XmlElement[] = [];
  const stack: Array<{ name: string; element?: XmlElement }> = [];
  walkXml(xml, {
    text(value) {
      const parent = stack.at(-1)?.element;
      if (parent) parent.text += value;
    },
    open(name, attributes, selfClosing, span) {
      const parent = stack.at(-1)?.element;
      if (parent) parent.nested = true;
      const element = select(name)
        ? { ...span!, contentStart: span!.end, contentEnd: span!.end, depth: stack.length, name, attributes, text: "", nested: false }
        : undefined;
      if (element) elements.push(element);
      if (!selfClosing) stack.push({ name, element });
    },
    close(name, span) {
      const opened = stack.pop();
      if (opened?.name !== name) throw new DocumentError("Cannot edit unbalanced document XML");
      if (opened.element) {
        opened.element.end = span!.end;
        opened.element.contentEnd = span!.start;
      }
    },
  });
  if (stack.length > 0) throw new DocumentError("Cannot edit incomplete document XML");
  return elements;
}

export interface XmlReplacement extends XmlSpan { replacement: string }

/** Coordinates refer to the original XML; overlapping edits are never applied partially. */
export function replaceXml(xml: string, replacements: readonly XmlReplacement[]): string {
  const sorted = [...replacements].sort((a, b) => a.start - b.start);
  let end = 0;
  const output: string[] = [];
  for (const change of sorted) {
    if (change.start < end) throw new DocumentError("Edits overlap; edit each target only once");
    output.push(xml.slice(end, change.start), change.replacement);
    end = change.end;
  }
  output.push(xml.slice(end));
  return output.join("");
}
