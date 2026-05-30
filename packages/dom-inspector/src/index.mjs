
export async function takeAriaSnapshot(page) {
  const raw = await page.locator("body").ariaSnapshot().catch(() => "");
  if (!raw) {
    return { raw: "", tree: [] };
  }

  return {
    raw,
    tree: parseAriaSnapshot(raw),
  };
}

export function parseAriaSnapshot(raw) {
  const lines = raw.split("\n").filter((line) => line.trim());
  const root = { children: [] };
  const stack = [{ depth: -1, node: root }];

  for (const line of lines) {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith("- ")) continue;

    const depth = (line.length - trimmed.length) / 2;
    const content = trimmed.slice(2);

    // Remove trailing colon for container nodes
    const cleanContent = content.endsWith(":") ? content.slice(0, -1).trim() : content;

    // Parse: role "name" [attr=value] [attr]
    const roleMatch = cleanContent.match(/^(\w+)/);
    if (!roleMatch) continue;

    const role = roleMatch[1];
    const rest = cleanContent.slice(roleMatch[0].length).trim();

    // Parse quoted name
    let name = "";
    let remaining = rest;
    const nameMatch = remaining.match(/^"([^"]*)"/);
    if (nameMatch) {
      name = nameMatch[1];
      remaining = remaining.slice(nameMatch[0].length).trim();
    }

    // Parse attributes [key=value] or [key]
    const attrs = {};
    let attrMatch;
    const attrRegex = /\[([^\]]+)\]/g;
    while ((attrMatch = attrRegex.exec(remaining)) !== null) {
      const attrStr = attrMatch[1];
      const eqIdx = attrStr.indexOf("=");
      if (eqIdx >= 0) {
        const key = attrStr.slice(0, eqIdx).trim();
        const val = attrStr.slice(eqIdx + 1).trim();
        attrs[key] = val;
      } else {
        attrs[attrStr.trim()] = true;
      }
    }

    const node = {
      role,
      name: name || null,
      ref: attrs.ref || null,
      level: attrs.level ? Number(attrs.level) : null,
      checked: attrs.checked === true ? true : attrs.checked === "false" ? false : null,
      disabled: attrs.disabled === true || attrs.disabled === "true",
      expanded: attrs.expanded === true ? true : attrs.expanded === "false" ? false : null,
      selected: attrs.selected === true || attrs.selected === "true",
      children: [],
    };

    // Pop stack until parent depth < current depth
    while (stack.length > 1 && stack.at(-1).depth >= depth) {
      stack.pop();
    }

    const parent = stack.at(-1).node;
    parent.children.push(node);

    // Check if this node has children (line ended with :)
    const hasChildren = content.endsWith(":");
    if (hasChildren || node.role === "list") {
      stack.push({ depth, node });
    }
  }

  return root.children;
}

export function ariaTreeToPlainText(tree, indent = 0) {
  const lines = [];
  const prefix = "  ".repeat(indent);

  for (const node of tree) {
    const ref = node.ref ? ` [${node.ref}]` : "";
    const label = node.name || "";
    const extras = [];
    if (node.level) extras.push(`h${node.level}`);
    if (node.checked !== null) extras.push(node.checked ? "checked" : "unchecked");
    if (node.disabled) extras.push("disabled");
    const extra = extras.length ? ` (${extras.join(", ")})` : "";

    let line = `${prefix}${node.role}${label ? ` "${label}"` : ""}${extra}${ref}`;
    lines.push(line);

    if (node.children.length) {
      lines.push(ariaTreeToPlainText(node.children, indent + 1));
    }
  }

  return lines.join("\n");
}

export function collectAriaRefs(tree, refs = new Map()) {
  for (const node of tree) {
    if (node.ref) {
      refs.set(node.ref, { role: node.role, name: node.name });
    }
    if (node.children.length) {
      collectAriaRefs(node.children, refs);
    }
  }
  return refs;
}
