/**
 * Minimal XML reader for DASH manifests. The service worker has no DOMParser,
 * and MPDs use a small, regular subset of XML: elements, attributes, text,
 * comments, CDATA and the XML declaration. Namespace prefixes are dropped
 * ("cenc:pssh" → "pssh"), which is what MPD consumers want.
 */

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, ent: string) => {
    if (ent[0] === "#") {
      const code = ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[ent] ?? whole;
  });
}

function localName(qname: string): string {
  const i = qname.indexOf(":");
  return i === -1 ? qname : qname.slice(i + 1);
}

const ATTR = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;

export function parseXml(input: string): XmlNode {
  const root: XmlNode = { name: "#document", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  let i = 0;
  const n = input.length;

  while (i < n) {
    const lt = input.indexOf("<", i);
    const textEnd = lt === -1 ? n : lt;
    if (textEnd > i) stack[stack.length - 1]!.text += decode(input.slice(i, textEnd));
    if (lt === -1) break;

    if (input.startsWith("<!--", lt)) {
      const end = input.indexOf("-->", lt + 4);
      if (end === -1) throw new Error("XML: unterminated comment");
      i = end + 3;
    } else if (input.startsWith("<![CDATA[", lt)) {
      const end = input.indexOf("]]>", lt + 9);
      if (end === -1) throw new Error("XML: unterminated CDATA");
      stack[stack.length - 1]!.text += input.slice(lt + 9, end);
      i = end + 3;
    } else if (input.startsWith("<?", lt) || input.startsWith("<!", lt)) {
      const end = input.indexOf(">", lt);
      if (end === -1) throw new Error("XML: unterminated declaration");
      i = end + 1;
    } else if (input[lt + 1] === "/") {
      const end = input.indexOf(">", lt);
      if (end === -1) throw new Error("XML: unterminated end tag");
      const name = localName(input.slice(lt + 2, end).trim());
      const open = stack.pop();
      if (!open || open.name !== name) throw new Error(`XML: mismatched </${name}>`);
      i = end + 1;
    } else {
      // start tag: find the closing '>' outside quotes
      let j = lt + 1;
      let quote: string | null = null;
      for (; j < n; j++) {
        const c = input[j]!;
        if (quote) {
          if (c === quote) quote = null;
        } else if (c === '"' || c === "'") quote = c;
        else if (c === ">") break;
      }
      if (j >= n) throw new Error("XML: unterminated start tag");
      let body = input.slice(lt + 1, j);
      const selfClosing = body.endsWith("/");
      if (selfClosing) body = body.slice(0, -1);
      const nameMatch = /^[^\s]+/.exec(body);
      if (!nameMatch) throw new Error("XML: empty tag");
      const node: XmlNode = { name: localName(nameMatch[0]), attrs: {}, children: [], text: "" };
      ATTR.lastIndex = nameMatch[0].length;
      for (let m = ATTR.exec(body); m; m = ATTR.exec(body)) {
        node.attrs[localName(m[1]!)] = decode(m[3] ?? m[4] ?? "");
      }
      stack[stack.length - 1]!.children.push(node);
      if (!selfClosing) stack.push(node);
      i = j + 1;
    }
  }
  if (stack.length !== 1) throw new Error(`XML: unclosed <${stack[stack.length - 1]!.name}>`);
  const top = root.children[0];
  if (!top) throw new Error("XML: no root element");
  return top;
}

export function child(node: XmlNode | undefined, name: string): XmlNode | undefined {
  return node?.children.find((c) => c.name === name);
}

export function children(node: XmlNode | undefined, name: string): XmlNode[] {
  return node ? node.children.filter((c) => c.name === name) : [];
}
