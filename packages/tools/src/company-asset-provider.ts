import type {
  AssetCategory,
  CompanyAssetReference,
} from "@firefly/schemas";

export type { CompanyAssetReference } from "@firefly/schemas";

/** Server-resolved authorization scope. Never construct this from provider query fields. */
export interface CompanyAssetProviderScope {
  readonly tenantId: string;
  readonly actorAccountId: string;
  readonly allowedBrandIds: readonly string[];
  readonly allowedVehicleIds: readonly string[];
}

export interface CompanyAssetCatalogQuery {
  readonly categories?: readonly AssetCategory[];
  readonly brandId?: string;
  readonly vehicleId?: string;
  readonly searchText?: string;
  readonly tags?: readonly string[];
  readonly cursor?: string;
  readonly limit: number;
}

export interface CompanyAssetPreview {
  readonly mediaType: string;
  readonly width: number;
  readonly height: number;
  readonly durationSeconds?: number;
  readonly thumbnailUrl?: string;
}

/** Public provider DTO consumed by API, workflow, and UI code. */
export interface CompanyAssetCatalogItem {
  readonly reference: CompanyAssetReference;
  readonly displayName: string;
  readonly description?: string;
  readonly brandIds: readonly string[];
  readonly tags: readonly string[];
  readonly preview: CompanyAssetPreview;
  readonly updatedAt: string;
}

export interface CompanyAssetCatalogPage {
  readonly items: readonly CompanyAssetCatalogItem[];
  readonly nextCursor?: string;
}

export interface CompanyAssetResolveResult {
  readonly items: readonly CompanyAssetCatalogItem[];
  readonly missingReferences: readonly CompanyAssetReference[];
}

export interface CompanyAssetProviderRequestOptions {
  readonly signal?: AbortSignal;
}

/**
 * Replaceable read-only company asset catalog port.
 *
 * Implementations must enforce the server-resolved scope and return only the
 * public DTO above. Provider-specific records must not escape this boundary.
 */
export interface CompanyAssetProvider {
  readonly providerId: string;

  searchAssets(
    query: Readonly<CompanyAssetCatalogQuery>,
    scope: Readonly<CompanyAssetProviderScope>,
    options?: Readonly<CompanyAssetProviderRequestOptions>,
  ): Promise<CompanyAssetCatalogPage>;

  resolveAssets(
    references: readonly CompanyAssetReference[],
    scope: Readonly<CompanyAssetProviderScope>,
    options?: Readonly<CompanyAssetProviderRequestOptions>,
  ): Promise<CompanyAssetResolveResult>;
}
