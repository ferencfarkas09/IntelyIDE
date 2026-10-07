import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

/** Token colours from the design tokens; shared by the diff view and the editor. */
export const highlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword, t.modifier, t.self], color: "var(--syn-keyword)" },
    { tag: [t.string, t.special(t.string), t.regexp, t.character], color: "var(--syn-string)" },
    { tag: [t.number, t.bool, t.null, t.atom, t.unit, t.constant(t.name), t.escape], color: "var(--syn-number)" },
    { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--syn-meta)", fontStyle: "italic" },
    { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName, t.labelName], color: "var(--syn-function)" },
    { tag: [t.typeName, t.className, t.namespace, t.standard(t.typeName)], color: "var(--syn-type)" },
    { tag: [t.propertyName, t.definition(t.propertyName)], color: "var(--syn-property)" },
    { tag: [t.attributeName], color: "var(--syn-attr)" },
    { tag: [t.tagName], color: "var(--syn-tag)" },
    { tag: [t.angleBracket, t.operator, t.punctuation, t.separator, t.bracket, t.derefOperator], color: "var(--text-2)" },
    { tag: [t.meta, t.processingInstruction, t.documentMeta], color: "var(--syn-meta)" },
    { tag: [t.heading, t.strong], fontWeight: "600", color: "var(--text-1)" },
    { tag: [t.link, t.url], color: "var(--syn-function)", textDecoration: "underline" },
    { tag: t.emphasis, fontStyle: "italic" },
    { tag: t.strikethrough, textDecoration: "line-through" },
    { tag: t.invalid, color: "var(--danger)" },
  ]),
);
