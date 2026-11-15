/** Product names matching what a shopper typed into the search box. */
export function searchProducts(names: string[], query: string): string[] {
  const pattern = new RegExp(query, "i");
  return names.filter((name) => pattern.test(name));
}
