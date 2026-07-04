import type { CatalogEntry, DiscoveryPreview } from "../../types/api";

export const catalogEntries: CatalogEntry[] = [
  {
    id: "builtin:petstore",
    source: "builtin",
    slug: "petstore",
    name: "Swagger Petstore",
    description: "The canonical OpenAPI sample API — pets, orders, and inventory.",
    kind: "rest",
    category: "Examples",
    tags: ["demo", "no-auth", "openapi-sample"],
    icon: "paw-print",
    healthUrl: "https://petstore3.swagger.io/",
    openapiUrl: "https://petstore3.swagger.io/api/v3/openapi.json",
    featured: true,
  },
  {
    id: "custom:1",
    source: "custom",
    slug: "internal-crm-staging",
    name: "Internal CRM (staging)",
    description: "Reusable template for spinning up a staging CRM registration.",
    kind: "rest",
    category: "Internal",
    tags: ["internal", "staging"],
    icon: null,
    healthUrl: "https://crm.staging.internal/health",
    openapiUrl: "https://crm.staging.internal/openapi.json",
    featured: false,
  },
];

export const discoveryPreview: DiscoveryPreview = {
  count: 5,
  tools: [
    { name: "list_pets", method: "GET", endpoint: "/pet/findByStatus", description: "Finds pets by status" },
    { name: "get_pet", method: "GET", endpoint: "/pet/{petId}", description: "Find pet by ID" },
    { name: "add_pet", method: "POST", endpoint: "/pet", description: "Add a new pet to the store" },
    { name: "update_pet", method: "PUT", endpoint: "/pet", description: "Update an existing pet" },
    { name: "delete_pet", method: "DELETE", endpoint: "/pet/{petId}", description: "Deletes a pet" },
  ],
};
