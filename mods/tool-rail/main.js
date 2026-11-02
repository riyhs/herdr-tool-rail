import { View, div, svg } from "gpui-kit";
import { v_flex } from "gpui-base";
import { layout, run, spaces, theme, updates, shared, setShared } from "herdr";

const PAD = 6;
const SIZE = 30;
const GAP = 6;

const ICONS = {
  files: { label: "Files", panel: true, mod: "files" },
  changes: { label: "Changes", panel: true, mod: "changes" },
  graph: { label: "Git Graph", panel: true, mod: "git-graph", icon: "mods/tool-rail/graph.svg" },
  servers: { label: "Servers", panel: true, mod: "servers" },
  mods: { label: "Mods", panel: true, mod: "mods-menu" },
  insights: { label: "Insights", mod: "insights", action: () => run("tab.new", { name: "Insights", mod: "insights" }), icon: "mods/tool-rail/insights.svg" },
  notes: { label: "Notes", panel: true, mod: "tab-notes", icon: "mods/tool-rail/notes.svg" },
  settings: { label: "Settings", action: () => run("app.settings") },
  machine: { label: "Add machine", action: () => run("mod.open", { name: "machine-add" }) },
};

const DEFAULT_ITEMS = {
  top: ["files", "changes", "graph", "servers", "mods"],
  bottom: ["insights", "notes", "settings", "machine"],
};

const ITEMS_VERSION = 2;

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

function cleanItems(raw) {
  const items = { top: [], bottom: [] };
  const seen = new Set();
  for (const group of ["top", "bottom"]) {
    const list = raw && Array.isArray(raw[group]) ? raw[group] : [];
    for (const id of list) {
      if (ICONS[id] && !seen.has(id)) {
        items[group].push(id);
        seen.add(id);
      }
    }
  }
  for (const group of ["top", "bottom"]) {
    for (const id of DEFAULT_ITEMS[group]) {
      if (!seen.has(id)) {
        items[group].push(id);
        seen.add(id);
      }
    }
  }
  return items;
}

function migrateItems(items) {
  if (Number(localStorage.getItem("stripe.itemsVersion") ?? 0) >= ITEMS_VERSION) return;
  const place = (id, group, indexFor) => {
    for (const key of ["top", "bottom"]) items[key] = items[key].filter((item) => item !== id);
    const list = items[group];
    const index = Math.max(0, Math.min(list.length, indexFor(list)));
    list.splice(index, 0, id);
  };
  place("graph", "top", (list) => {
    const index = list.indexOf("changes");
    return index < 0 ? 0 : index + 1;
  });
  place("insights", "bottom", (list) => {
    const index = list.indexOf("notes");
    return index < 0 ? 0 : index;
  });
  localStorage.setItem("stripe.items", JSON.stringify(items));
  localStorage.setItem("stripe.itemsVersion", String(ITEMS_VERSION));
}

function readItems() {
  let raw = null;
  try {
    raw = JSON.parse(localStorage.getItem("stripe.items") ?? "null");
  } catch {}
  const items = cleanItems(raw);
  migrateItems(items);
  return items;
}

function panelId(mod) {
  for (const [id, def] of Object.entries(ICONS)) {
    if (def.panel && (def.mod ?? id) === mod) return id;
  }
  return null;
}

function isPanelBlock(node) {
  return node?.type === "block" && Boolean(panelId(node?.content?.mod));
}

function disabledMods() {
  const raw = shared("mods.disabled");
  return new Set(Array.isArray(raw) ? raw.filter((name) => typeof name === "string") : []);
}

function modOf(id) {
  return ICONS[id]?.mod ?? null;
}

function disabledId(id, disabled = disabledMods()) {
  const mod = modOf(id);
  return Boolean(mod && mod !== "mods-menu" && mod !== "tool-rail" && disabled.has(mod));
}

function groupOf(items, id) {
  if (items.top.includes(id)) return "top";
  if (items.bottom.includes(id)) return "bottom";
  return null;
}

function readSlots() {
  const root = layout();
  return {
    root,
    panel: find(root, "panel"),
    topNode: find(root, "slot-top"),
    bottomNode: find(root, "slot-bottom"),
    gapNode: find(root, "panel-gap"),
  };
}

function cleanId(value) {
  return typeof value === "string" && ICONS[value]?.panel ? value : null;
}

function normalizeState(raw) {
  if (!raw || typeof raw !== "object") return null;
  const top = cleanId(raw.top);
  const bottom = cleanId(raw.bottom);
  const legacyTop = raw.topOpen === undefined && top;
  const legacyBottom = raw.bottomOpen === undefined && bottom;
  return {
    top,
    topOpen: Boolean((raw.topOpen ?? legacyTop) && top),
    bottom,
    bottomOpen: Boolean((raw.bottomOpen ?? legacyBottom) && bottom),
  };
}

function setHidden(node, hidden) {
  if (!node || Boolean(node.hidden) === hidden) return;
  node.hidden = hidden;
  run(`layout.${hidden ? "hide" : "show"}`, { id: node.id });
}

export default class Stripe extends View {
  init(_props, cx) {
    this.items = readItems();
    this.height = 0;
    this.drag = null;
    this.drop = null;
    this.suppressClick = false;
    this.space = undefined;
    this.ensured = false;
    this.disabledKey = null;
    let states = {};
    try {
      states = JSON.parse(localStorage.getItem("stripe.spaces") ?? "{}");
    } catch {}
    this.states = states && typeof states === "object" ? states : {};
    this.publishMods();
    cx.timer.after(0, (cx) => {
      if (this.ensured) return;
      this.ensured = true;
      if (this.ensureLayout()) {
        this.space = undefined;
        cx.notify();
      }
    });
  }

  saveItems() {
    localStorage.setItem("stripe.items", JSON.stringify(this.items));
    this.publishMods();
  }

  publishMods() {
    const mods = new Set();
    for (const group of ["top", "bottom"]) {
      for (const id of this.items[group]) {
        const mod = modOf(id);
        if (mod) mods.add(mod);
      }
    }
    setShared("stripe.modIds", [...mods]);
  }

  saveSpace(state) {
    if (!this.space) return;
    this.states[this.space] = state;
    localStorage.setItem("stripe.spaces", JSON.stringify(this.states));
  }

  currentState() {
    const raw = this.space ? this.states[this.space] : null;
    return normalizeState(raw) ?? { top: null, topOpen: false, bottom: null, bottomOpen: false };
  }

  ensureLayout() {
    const root = layout();
    const panel = find(root, "panel");
    const top = find(root, "slot-top");
    const bottom = find(root, "slot-bottom");
    if (!panel || !top || !bottom) return false;

    const desired = { top: [], bottom: [] };
    for (const group of ["top", "bottom"]) {
      for (const id of this.items[group]) {
        if (ICONS[id]?.panel) desired[group].push(id);
      }
    }

    const blocks = [];
    const collect = (node) => {
      for (const child of node?.children ?? []) {
        if (isPanelBlock(child)) blocks.push(child);
        collect(child);
      }
    };
    collect(panel);

    let dirty = false;
    const used = new Set();
    const make = (id) => ({
      id: `panel-${id}`,
      type: "block",
      content: { mod: ICONS[id].mod ?? id },
      size: { weight: 1 },
      hidden: true,
    });

    for (const group of ["top", "bottom"]) {
      const slot = group === "top" ? top : bottom;
      const children = [];
      for (const id of desired[group]) {
        let block = blocks.find((candidate) => !used.has(candidate) && panelId(candidate.content?.mod) === id);
        if (!block) {
          block = make(id);
          blocks.push(block);
          dirty = true;
        }
        if (block.id !== `panel-${id}`) { block.id = `panel-${id}`; dirty = true; }
        if (block.type !== "block") { block.type = "block"; dirty = true; }
        if (block.size?.weight !== 1) { block.size = { weight: 1 }; dirty = true; }
        if (block.hidden === undefined) { block.hidden = true; dirty = true; }
        used.add(block);
        children.push(block);
      }
      if (!Array.isArray(slot.children)) { slot.children = []; dirty = true; }
      const same = slot.children.length === children.length && slot.children.every((child, index) => child === children[index]);
      if (!same) { slot.children = children; dirty = true; }
    }

    let gap = find(panel, "panel-gap");
    if (!gap) {
      gap = { id: "panel-gap", type: "block", content: { mod: "panel-empty" }, size: { px: 8 }, hidden: true };
      dirty = true;
    } else {
      if (gap.type !== "block") { gap.type = "block"; dirty = true; }
      if (gap.content?.mod !== "panel-empty") { gap.content = { mod: "panel-empty" }; dirty = true; }
      if (gap.size?.px !== 8) { gap.size = { px: 8 }; dirty = true; }
      if (gap.hidden === undefined) { gap.hidden = true; dirty = true; }
    }

    const children = [top, gap, bottom];
    if (!panel.children || panel.children.length !== 3 || panel.children.some((child, index) => child !== children[index])) {
      panel.children = children;
      dirty = true;
    }
    if (!dirty) return false;
    run("layout.set", { layout: root });
    return true;
  }

  applySlots(state, remember = true) {
    const slots = readSlots();
    if (!slots.panel || !slots.topNode || !slots.bottomNode) return;
    const next = {
      top: cleanId(state?.top),
      topOpen: Boolean(state?.topOpen),
      bottom: cleanId(state?.bottom),
      bottomOpen: Boolean(state?.bottomOpen),
    };
    if (next.topOpen && !next.top) next.topOpen = false;
    if (next.bottomOpen && !next.bottom) next.bottomOpen = false;
    const disabled = disabledMods();
    if (next.topOpen && disabledId(next.top, disabled)) next.topOpen = false;
    if (next.bottomOpen && disabledId(next.bottom, disabled)) next.bottomOpen = false;
    if (next.topOpen && groupOf(this.items, next.top) !== "top") next.topOpen = false;
    if (next.bottomOpen && groupOf(this.items, next.bottom) !== "bottom") next.bottomOpen = false;
    if (next.topOpen && next.bottomOpen && next.top === next.bottom) next.bottomOpen = false;

    const topBlocks = slots.topNode.children ?? [];
    const bottomBlocks = slots.bottomNode.children ?? [];
    const has = (children, id) => children.some((block) => panelId(block.content?.mod) === id);
    if (next.topOpen && !has(topBlocks, next.top)) next.topOpen = false;
    if (next.bottomOpen && !has(bottomBlocks, next.bottom)) next.bottomOpen = false;

    for (const [node, children, id, open] of [
      [slots.topNode, topBlocks, next.top, next.topOpen],
      [slots.bottomNode, bottomBlocks, next.bottom, next.bottomOpen],
    ]) {
      if (open) {
        for (const block of children) setHidden(block, panelId(block.content?.mod) !== id);
        setHidden(node, false);
      } else {
        setHidden(node, true);
      }
    }

    const both = next.topOpen && next.bottomOpen;
    if (slots.gapNode) setHidden(slots.gapNode, !both);
    setHidden(slots.panel, !(next.topOpen || next.bottomOpen));
    if (remember) this.saveSpace(next);
  }

  openPanel(group, id) {
    if (disabledId(id)) return;
    const next = this.currentState();
    const openSlot = next.topOpen && next.top === id ? "top"
      : next.bottomOpen && next.bottom === id ? "bottom"
        : null;
    if (openSlot) {
      next[`${openSlot}Open`] = false;
      this.applySlots(next);
      return;
    }
    const target = groupOf(this.items, id) ?? group;
    next[target] = id;
    next[`${target}Open`] = true;
    this.applySlots(next);
  }

  syncSpace() {
    const space = spaces().find((candidate) => candidate.active);
    if (!space) return;
    if (space.id === this.space) return;
    this.space = space.id;
    const saved = normalizeState(this.states[space.id]);
    if (saved) {
      this.applySlots(saved, false);
      return;
    }
    const initial = { top: null, topOpen: false, bottom: null, bottomOpen: false };
    this.states[space.id] = initial;
    this.applySlots(initial, false);
  }

  panelOpenAnywhere(id) {
    if (disabledId(id)) return false;
    for (const raw of Object.values(this.states)) {
      const state = normalizeState(raw);
      if (state && ((state.topOpen && state.top === id) || (state.bottomOpen && state.bottom === id))) return true;
    }
    return false;
  }

  visible(group, disabled = disabledMods()) {
    return this.items[group].filter((id) => !disabledId(id, disabled));
  }

  applyDisabledLayout(disabled = disabledMods()) {
    if (!disabled.size) return;
    const root = layout();
    const hide = (node) => {
      const mod = node?.content?.mod;
      if (node?.id && typeof mod === "string" && mod !== "mods-menu" && mod !== "tool-rail" && disabled.has(mod)) {
        run("layout.hide", { id: node.id });
      }
      for (const child of node?.children ?? []) hide(child);
      for (const child of node?.floating ?? []) hide(child);
    };
    hide(root);
  }

  targetAt(y) {
    const top = this.visible("top");
    const bottom = this.visible("bottom");
    const topCount = top.length;
    const bottomCount = bottom.length;
    const topStart = PAD;
    const topEnd = PAD + topCount * SIZE + Math.max(0, topCount - 1) * GAP;
    const bottomStart = this.height - PAD - bottomCount * SIZE - Math.max(0, bottomCount - 1) * GAP;
    let group;
    if (topCount > 0 && y <= topEnd + GAP / 2) group = "top";
    else if (bottomCount > 0 && y >= bottomStart - GAP / 2) group = "bottom";
    else group = y < this.height / 2 ? "top" : "bottom";
    const start = group === "top" ? topStart : bottomStart;
    const list = group === "top" ? top : bottom;
    const index = Math.max(0, Math.min(list.length, Math.round((y - start) / (SIZE + GAP))));
    return { group, index };
  }

  moveTo(y, cx) {
    if (!this.drag) return;
    if (Math.abs(y - this.drag.startY) > 4) this.drag.moved = true;
    const next = this.targetAt(y);
    if (this.drag.locked && next.group !== this.drag.group) {
      if (this.drop) {
        this.drop = null;
        cx.notify();
      }
      return;
    }
    if (!this.drop || this.drop.group !== next.group || this.drop.index !== next.index) {
      this.drop = next;
      cx.notify();
    }
  }

  moveBlock(id, group) {
    const slots = readSlots();
    const top = slots.topNode;
    const bottom = slots.bottomNode;
    if (!slots.panel || !top || !bottom) return;
    let block = find(slots.panel, `panel-${id}`);
    if (!block) {
      const found = [];
      const collect = (node) => {
        for (const child of node?.children ?? []) {
          if (isPanelBlock(child) && panelId(child.content?.mod) === id) found.push(child);
          collect(child);
        }
      };
      collect(slots.panel);
      block = found[0];
    }
    if (!block) {
      block = {
        id: `panel-${id}`,
        type: "block",
        content: { mod: ICONS[id].mod ?? id },
        size: { weight: 1 },
        hidden: true,
      };
    }
    for (const parent of [top, bottom]) {
      const index = parent.children?.indexOf(block) ?? -1;
      if (index >= 0) parent.children.splice(index, 1);
    }
    block.hidden = true;
    const target = group === "top" ? top : bottom;
    target.children = [...(target.children ?? []), block];
    run("layout.set", { layout: slots.root });
  }

  finishDrag(cx) {
    if (!this.drag) return;
    const drag = this.drag;
    const drop = this.drop;
    this.drag = null;
    this.drop = null;
    if (!drag.moved || !drop) {
      cx.notify();
      return;
    }
    this.suppressClick = true;
    if (drop.group !== drag.group && this.panelOpenAnywhere(drag.id)) {
      cx.notify();
      return;
    }
    const from = this.items[drag.group];
    const fromIndex = from.indexOf(drag.id);
    if (fromIndex < 0) {
      cx.notify();
      return;
    }
    const fromVisibleIndex = this.visible(drag.group).indexOf(drag.id);
    from.splice(fromIndex, 1);
    const targetVisible = this.visible(drop.group);
    let toVisible = drop.index;
    if (drag.group === drop.group && fromVisibleIndex >= 0 && fromVisibleIndex < toVisible) toVisible -= 1;
    toVisible = Math.max(0, Math.min(targetVisible.length, toVisible));
    const target = this.items[drop.group];
    const anchor = targetVisible[toVisible];
    const toIndex = anchor ? target.indexOf(anchor) : target.length;
    target.splice(toIndex, 0, drag.id);
    this.saveItems();
    if (drag.group !== drop.group) this.moveBlock(drag.id, drop.group);
    cx.notify();
  }

  dropLine(group, index) {
    const count = this.visible(group).length;
    const start = group === "top"
      ? PAD
      : this.height - PAD - count * SIZE - Math.max(0, count - 1) * GAP;
    return Math.max(PAD / 2, start + index * (SIZE + GAP) - GAP / 2);
  }

  icon(id, group, index) {
    const t = theme();
    const def = ICONS[id];
    const state = this.currentState();
    const on = Boolean(def.panel) && ((state.topOpen && state.top === id) || (state.bottomOpen && state.bottom === id));
    const count = this.visible(group).length;
    const y = group === "top"
      ? PAD + index * (SIZE + GAP)
      : this.height - PAD - count * SIZE - Math.max(0, count - 1) * GAP + index * (SIZE + GAP);
    const dragging = this.drag?.id === id && this.drag.moved;
    return div().id(`stripe-${id}`).relative().flex_none().size(SIZE).flex().items_center().justify_center().rounded(6).cursor_pointer()
      .tooltip(def.label)
      .bg(on ? t.accent : t.chrome).text_color(on ? t.accent_foreground : t.muted)
      .when(!on, (el) => el.hover((s) => s.bg(t.hover).text_color(t.foreground)))
      .when(dragging, (el) => el.opacity(0.35).cursor_grabbing())
      .on_mouse_down("left", (e, cx) => {
        this.suppressClick = false;
        this.drag = {
          id,
          group,
          startY: y + (e.local_position?.y ?? 0),
          moved: false,
          locked: def.panel ? this.panelOpenAnywhere(id) : false,
        };
        this.drop = null;
        cx.notify();
      })
      .on_mouse_move((e, cx) => this.moveTo(y + e.local_position.y, cx))
      .on_mouse_up("left", (_e, cx) => this.finishDrag(cx))
      .on_click((_e, cx) => {
        if (this.suppressClick) {
          this.suppressClick = false;
          return;
        }
        if (def.panel) {
          this.openPanel(group, id);
          cx.notify();
        } else {
          def.action();
        }
      })
      .child(svg(def.icon ?? `mods/tool-rail/${id}.svg`).size(20))
      .when(id === "settings" && Boolean(updates().app.ready), (el) => el.child(div().absolute().top(3).right(3).size(7).rounded_full().bg(t.accent)));
  }

  syncDisabled() {
    if (!this.space) return;
    const disabled = disabledMods();
    if (!disabled.size) return;
    const state = this.currentState();
    let changed = false;
    if (state.topOpen && disabledId(state.top, disabled)) { state.topOpen = false; changed = true; }
    if (state.bottomOpen && disabledId(state.bottom, disabled)) { state.bottomOpen = false; changed = true; }
    if (!changed) return;
    this.states[this.space] = state;
    localStorage.setItem("stripe.spaces", JSON.stringify(this.states));
    this.applySlots(state, false);
  }

  render() {
    const t = theme();
    this.syncSpace();
    this.syncDisabled();
    const disabled = disabledMods();
    const key = [...disabled].sort().join("\n");
    if (key !== this.disabledKey) {
      this.disabledKey = key;
      this.applyDisabledLayout(disabled);
    }
    const top = this.visible("top", disabled);
    const bottom = this.visible("bottom", disabled);
    const line = this.drop ? this.dropLine(this.drop.group, this.drop.index) : null;
    return v_flex().id("stripe").relative().size_full().items_center().py(PAD).gap(GAP).bg(t.chrome).border_l(1).border_color(t.border)
      .on_size_change((size, cx) => {
        if (this.height === size.height) return;
        this.height = size.height;
        cx.notify();
      })
      .on_mouse_move((e, cx) => this.moveTo(e.local_position.y, cx))
      .on_mouse_up("left", (_e, cx) => this.finishDrag(cx))
      .children(top.map((id, index) => this.icon(id, "top", index)))
      .child(div().flex_1())
      .children(bottom.map((id, index) => this.icon(id, "bottom", index)))
      .when(line !== null, (el) => el.child(div().absolute().top(line).left(10).w(20).h(2).rounded(1).bg(t.accent)));
  }
}
