// Menu item builders shared by buttons and right-click menus.
// (Animations and methods are picked in their own windows: see animpicker.js and methodpicker.js.)

import { store } from "./store.js";

export function addObjectItems(onPick) {
  const { catalog } = store;
  return catalog.mobCategories.map((cat) => ({
    label: cat,
    children: catalog.mobjects.filter((m) => m.category === cat && !m.needsTarget).map((m) => ({
      label: m.key,
      icon: m.icon,
      onClick: () => onPick(m.key),
    })),
  }));
}
