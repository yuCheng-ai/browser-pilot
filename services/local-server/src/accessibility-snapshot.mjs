export async function takeAccessibilitySnapshot(page) {
  const snapshot = await page.accessibility.snapshot({
    interestingOnly: true,
  });

  if (!snapshot) {
    return { text: "", tree: null };
  }

  return {
    text: formatAccessibilityTree(snapshot),
    tree: snapshot,
  };
}

function formatAccessibilityTree(node, depth = 0) {
  if (!node) return "";

  const indent = "  ".repeat(depth);
  const role = node.role || "unknown";
  const name = (node.name || "").slice(0, 120);
  const value = node.value ? `="${String(node.value).slice(0, 60)}"` : "";
  const description = [name, value].filter(Boolean).join(" ");

  let result = `${indent}- ${role}${description ? ": " + description : ""}\n`;

  if (node.children) {
    for (const child of node.children) {
      result += formatAccessibilityTree(child, depth + 1);
    }
  }

  return result;
}

export function accessibilityTreeToActionMap(snapshot) {
  const actions = [];

  function walk(node, path) {
    if (!node) return;

    const currentPath = path ? `${path} > ${node.role}` : node.role;
    const name = node.name || "";

    if (isActionable(node)) {
      actions.push({
        role: node.role,
        name,
        value: node.value || "",
        path: currentPath,
        ref: generateRef(node, actions.length),
      });
    }

    if (node.children) {
      for (const child of node.children) {
        walk(child, currentPath);
      }
    }
  }

  walk(snapshot, "");
  return actions;
}

function isActionable(node) {
  const actionableRoles = new Set([
    "button", "link", "textbox", "searchbox", "combobox",
    "listbox", "menuitem", "menuitemcheckbox", "menuitemradio",
    "option", "radio", "checkbox", "switch", "tab",
    "spinbutton", "slider",
  ]);

  return actionableRoles.has(node.role) || node.role === "heading";
}

function generateRef(node, index) {
  const name = (node.name || node.role || "element").replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, "_").slice(0, 40);
  return `${node.role}_${name}_${index}`;
}