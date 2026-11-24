// How tags and staples are written when people read them. Stored data stays lowercase; this only
// changes the words shown in replies, so "mexican" is stored but "Mexican" is what people see.

// Tags that are proper nouns (cuisines), with the way to show them. Anything not listed
// (big-cook, quick, chicken) is shown as stored.
const PROPER_TAGS: Record<string, string> = {
  mexican: "Mexican",
  "tex-mex": "Tex-Mex",
  italian: "Italian",
  thai: "Thai",
  indian: "Indian",
  chinese: "Chinese",
  japanese: "Japanese",
  korean: "Korean",
  vietnamese: "Vietnamese",
  greek: "Greek",
  french: "French",
  spanish: "Spanish",
  mediterranean: "Mediterranean",
  cajun: "Cajun",
  creole: "Creole",
  american: "American",
  german: "German",
  british: "British",
  irish: "Irish",
  turkish: "Turkish",
  lebanese: "Lebanese",
  moroccan: "Moroccan",
  ethiopian: "Ethiopian",
  caribbean: "Caribbean",
  hawaiian: "Hawaiian",
  filipino: "Filipino",
  brazilian: "Brazilian",
  peruvian: "Peruvian",
  southern: "Southern",
  "middle-eastern": "Middle Eastern",
  "middle eastern": "Middle Eastern",
};

// A tag as people should see it: "mexican" -> "Mexican", "tex-mex" -> "Tex-Mex".
export function displayTag(tag: string): string {
  return PROPER_TAGS[tag.trim().toLowerCase()] ?? tag;
}

// Tags joined for display.
export function displayTags(tags: readonly string[]): string {
  return tags.map(displayTag).join(", ");
}

// A staple as people should see it in a list: lowercase first letter ("Olive oil" -> "olive oil"),
// unless the first word is a proper noun from the list above ("Italian seasoning") or all capitals
// ("MSG"). Only the first letter changes.
export function displayStaple(text: string): string {
  const trimmed = text.trim();
  const firstWord = trimmed.split(/[\s,]+/)[0] ?? "";
  if (firstWord.length > 1 && firstWord === firstWord.toUpperCase() && /[A-Z]/.test(firstWord)) return trimmed;
  if (PROPER_TAGS[firstWord.toLowerCase()] !== undefined) return PROPER_TAGS[firstWord.toLowerCase()] + trimmed.slice(firstWord.length);
  return trimmed.charAt(0).toLowerCase() + trimmed.slice(1);
}
