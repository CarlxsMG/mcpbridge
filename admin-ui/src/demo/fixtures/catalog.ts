import type { CatalogEntry, DiscoveryPreview } from "@/types/api";
import { demoKey } from "../i18n-keys";

export const catalogEntries: Array<CatalogEntry & { descriptionKey?: string }> = [
  {
    id: "builtin:petstore",
    source: "builtin",
    slug: "petstore",
    name: "Swagger Petstore",
    description: "The canonical OpenAPI sample API — pets, orders, and inventory.",
    descriptionKey: demoKey("catalog", "builtin:petstore", "description"),
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
    descriptionKey: demoKey("catalog", "custom:1", "description"),
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
    {
      name: "list_pets",
      method: "GET",
      endpoint: "/pet/findByStatus",
      description: "Finds pets by status",
      descriptionKey: demoKey("discovery", "list_pets", "description"),
    },
    {
      name: "get_pet",
      method: "GET",
      endpoint: "/pet/{petId}",
      description: "Find pet by ID",
      descriptionKey: demoKey("discovery", "get_pet", "description"),
    },
    {
      name: "add_pet",
      method: "POST",
      endpoint: "/pet",
      description: "Add a new pet to the store",
      descriptionKey: demoKey("discovery", "add_pet", "description"),
    },
    {
      name: "update_pet",
      method: "PUT",
      endpoint: "/pet",
      description: "Update an existing pet",
      descriptionKey: demoKey("discovery", "update_pet", "description"),
    },
    {
      name: "delete_pet",
      method: "DELETE",
      endpoint: "/pet/{petId}",
      description: "Deletes a pet",
      descriptionKey: demoKey("discovery", "delete_pet", "description"),
    },
  ],
};
