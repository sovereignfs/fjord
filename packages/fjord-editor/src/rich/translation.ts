/**
 * What the visual editor says in its own words (its toolbar and its menus), through the one function MDXEditor asks: `translation(key, defaultValue, interpolations)`. MDXEditor hands
 * the English text with its blanks still in it (`Heading {{level}}`) and expects this to fill them, which its default does not, so the block-type menu said *Heading {{level}}*
 * for every level. The only key changed is the one a screen reader reads for the editing area, which a page may name (`label`).
 */
export function translator(label?: string): (key: string, defaultValue: string, interpolations?: Record<string, unknown>) => string {
  return (key, defaultValue, interpolations) => {
    if (key === "contentArea.editableMarkdown" && label !== undefined) return label;
    if (interpolations === undefined) return defaultValue;
    return defaultValue.replace(/\{\{\s*(\w+)\s*\}\}/g, (blank, name: string) => (name in interpolations ? String(interpolations[name]) : blank));
  };
}
