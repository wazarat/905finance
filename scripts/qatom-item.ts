import { qatomItemListing } from "../src/lib/qatom-item";

/**
 * Platform operation: print what to enter in the Qatom dashboard to list the
 * catalog item that carries messages to one sample seller's agent.
 *
 *   pnpm qatom:item <seller-slug> "<Seller name>" <https://your-site>
 *
 * Nothing is sent anywhere. Create the item yourself in the Qatom dashboard
 * (Catalog, New item), then add its id to QATOM_SELLER_ITEMS.
 */
const [slug, name, baseUrl] = process.argv.slice(2);
if (!slug || !name || !/^https:\/\//.test(baseUrl ?? "")) {
  console.error('Usage: pnpm qatom:item <seller-slug> "<Seller name>" <https://your-site>');
  process.exit(1);
}
const item = qatomItemListing({ slug, displayName: name }, baseUrl);
console.log(`
Create this item in the Qatom dashboard (Catalog > New item):

  Name          ${item.name}
  Descriptor    ${item.descriptor}
  Price         ${item.price}   (free: no money moves through Qatom)
  Method        ${item.method}
  Endpoint      ${item.endpoint}
  Visibility    ${item.visibility}   (leave "Private to this MCP instance" off; it cannot be changed later)

  Description
  ${item.description}

  Request headers & secret parameters > Add header
    Name         ${item.header.name}
    Sensitivity  ${item.header.sensitivity}
    Value        ${item.header.value}   (type it yourself; never paste it anywhere else)

  Service schema (paste, then Format)
${JSON.stringify(item.serviceSchema, null, 2)
  .split("\n")
  .map((line) => `  ${line}`)
  .join("\n")}

After creating it, reload the item page and check the header is listed, then add
"${slug}:<item id>" to QATOM_SELLER_ITEMS and redeploy.
`);
