import {
  mockCompanyAssetVisualDescriptions,
  visualDescriptionForMockCompanyAsset,
} from "./mock-company-asset-descriptions.ts";

export const LEAPMOTOR_C10_MOCK_ASSET_BUNDLE_ID = "leapmotor-c10-v1";

/**
 * Development-only catalog identity. These IDs intentionally do not reuse the
 * existing E5 demo scope. An administrator must create/confirm the matching
 * C10 vehicle facts before this bundle is associated with a production task.
 */
export const LEAPMOTOR_C10_MOCK_ASSET_BINDING = Object.freeze({
  tenantId: "tenant_firefly",
  brandId: "brand_leapmotor_demo",
  vehicleId: "vehicle_leapmotor_c10_demo",
});

export type MockCompanyAssetImageMediaType = "image/jpeg" | "image/webp";

export interface MockCompanyAssetMediaManifestEntry {
  readonly bundleId: string;
  readonly tenantId: string;
  readonly brandId: string;
  readonly vehicleId: string;
  readonly assetId: string;
  readonly version: number;
  readonly displayName: string;
  readonly visualDescription: string;
  readonly tags: readonly string[];
  readonly mediaType: MockCompanyAssetImageMediaType;
  readonly width: number;
  readonly height: number;
  readonly byteSize: number;
  readonly checksumSha256: string;
  readonly relativePath: string;
  readonly updatedAt: string;
}

type SourceGroup =
  | "metal-black"
  | "xilu-purple"
  | "pearl-white"
  | "purple-space"
  | "purple-interior"
  | "brown-space"
  | "brown-interior";

interface SourceGroupDefinition {
  readonly label: string;
  readonly tags: readonly string[];
}

const sourceGroups: Readonly<Record<SourceGroup, SourceGroupDefinition>> = {
  "metal-black": {
    label: "深色外观",
    tags: ["exterior", "source-group-metal-black"],
  },
  "xilu-purple": {
    label: "紫色外观",
    tags: ["exterior", "source-group-xilu-purple"],
  },
  "pearl-white": {
    label: "白色外观",
    tags: ["exterior", "source-group-pearl-white"],
  },
  "purple-space": {
    label: "紫色内饰",
    tags: ["interior", "source-group-purple-space"],
  },
  "purple-interior": {
    label: "紫色内饰",
    tags: ["interior", "source-group-purple-interior"],
  },
  "brown-space": {
    label: "棕色内饰",
    tags: ["interior", "source-group-brown-space"],
  },
  "brown-interior": {
    label: "棕色内饰",
    tags: ["interior", "source-group-brown-interior"],
  },
};

type ManifestRow = readonly [
  serial: string,
  group: SourceGroup,
  subject: string,
  sourceRelativePath: string,
  mediaType: MockCompanyAssetImageMediaType,
  byteSize: number,
  checksumSha256: string,
  tags: readonly string[],
];

const rows: readonly ManifestRow[] = [
  ["0001", "metal-black", "充电口特写", "金属黑/C10-金属黑-01-充电口特写.webp", "image/webp", 73998, "0f8ec16ec2faacdd92c6a33e29f764342223a86323e965e966a17379c3160715", ["detail", "charging-port"]],
  ["0002", "metal-black", "前组合灯特写", "金属黑/C10-金属黑-02-前组合灯特写.webp", "image/webp", 96854, "e149d6ccc196b95c23a3a766b0da639edc1e259bde47db2bd91f497766b64904", ["detail", "headlamp"]],
  ["0003", "metal-black", "轮毂特写", "金属黑/C10-金属黑-03-轮毂特写.webp", "image/webp", 140968, "1586a7b377d0672121e4fabdd4381aa2656c669bea455ea34a5ce11a6aee34fa", ["detail", "wheel"]],
  ["0004", "metal-black", "整车左侧面", "金属黑/C10-金属黑-04-整车左侧面.webp", "image/webp", 299010, "dbc1c3780b07dc03f7b1c08262440605e21f4abb7ba88143d39c883d0091fee7", ["full-vehicle", "left", "side-profile"]],
  ["0005", "metal-black", "整车正前", "金属黑/C10-金属黑-05-整车正前.jpg", "image/jpeg", 3254518, "3d11398336542d1f474f7d81756eb9739c524daa5e01e0b0bda178c4f040ca1e", ["full-vehicle", "front-view"]],
  ["0006", "metal-black", "整车正后", "金属黑/C10-金属黑-06-整车正后.jpg", "image/jpeg", 3165686, "1fc34f0878f28bac1cea5909cf3818e116e48e66a8f03da2f171e848fae308e1", ["full-vehicle", "rear-view"]],
  ["0007", "metal-black", "整车左前45度", "金属黑/C10-金属黑-07-整车左前45度.jpg", "image/jpeg", 3325156, "8c2f4feba7bbe7a4e6055882c63cb1d691dc7ef46bbdb8b64a3fcc772911f4e1", ["full-vehicle", "left", "front-three-quarter"]],
  ["0008", "metal-black", "整车右前45度", "金属黑/C10-金属黑-08-整车右前45度.jpg", "image/jpeg", 3265465, "b28565affa3d6b3d052a4be31c29befacdf36e73c001607c7c739d6a158a573a", ["full-vehicle", "right", "front-three-quarter"]],
  ["0009", "xilu-purple", "充电口特写", "曦露紫/C10-曦露紫-01-充电口特写.webp", "image/webp", 160020, "c8ee4b46b1416b10ee3df5e57dcdef8ce2320547a2ac4a7f05905328d0ed8435", ["detail", "charging-port"]],
  ["0010", "xilu-purple", "前组合灯特写", "曦露紫/C10-曦露紫-02-前组合灯特写.webp", "image/webp", 143476, "0702f6a9725b0935d24dd0101c5f0d1cbd57a724c57d7014e14ab94c5021ccea", ["detail", "headlamp"]],
  ["0011", "xilu-purple", "轮毂特写", "曦露紫/C10-曦露紫-03-轮毂特写.webp", "image/webp", 319262, "2020b30cd3b35e238a3d3ca8aba96dc4390726e1d56d897b56b5e0ad6985b62a", ["detail", "wheel"]],
  ["0012", "xilu-purple", "整车左侧面近景", "曦露紫/C10-曦露紫-04-整车左侧面-近景.webp", "image/webp", 586090, "bf3a09b0c8e31b4ae0cdf02e71303fa5b6e4628eddb0b8f32fadda7bc93f72cf", ["full-vehicle", "left", "side-profile", "close"]],
  ["0013", "xilu-purple", "整车左后45度", "曦露紫/C10-曦露紫-05-整车左后45度.jpg", "image/jpeg", 3886113, "d108fc6934907f08e75b424fb3b93b02a4c9231b87bc5ff6fdf9a65a01151145", ["full-vehicle", "left", "rear-three-quarter"]],
  ["0014", "xilu-purple", "整车正后", "曦露紫/C10-曦露紫-06-整车正后.jpg", "image/jpeg", 3787773, "32bbba4fbde7a8334e732adf3e5420c26074f1e0d1fe3c1360972ae92e4cc917", ["full-vehicle", "rear-view"]],
  ["0015", "xilu-purple", "整车左前45度", "曦露紫/C10-曦露紫-07-整车左前45度.jpg", "image/jpeg", 3907586, "6a4c52f459f256d163d0e7f0b4b49c68d2a37ce8745cd406b8fc93545fca3704", ["full-vehicle", "left", "front-three-quarter"]],
  ["0016", "xilu-purple", "整车正前", "曦露紫/C10-曦露紫-08-整车正前.jpg", "image/jpeg", 3982951, "f44c5387d3de16e634fa1e7accc638b2fd82db3e964cd7df4ff17b4f4c18bdd7", ["full-vehicle", "front-view"]],
  ["0017", "pearl-white", "前组合灯特写", "珍珠白/C10-珍珠白-01-前组合灯特写.webp", "image/webp", 49612, "e6c09e533e0efe200bfa65317fb223ecc1cd02a4b178defd934f48016a993557", ["detail", "headlamp"]],
  ["0018", "pearl-white", "整车左侧面", "珍珠白/C10-珍珠白-02-整车左侧面.webp", "image/webp", 258012, "9bb811fed00d56686ea87c1e26783cf2ea190d1c6fd7e5d7d6f3d5ab925a4df3", ["full-vehicle", "left", "side-profile"]],
  ["0019", "pearl-white", "充电口特写", "珍珠白/C10-珍珠白-03-充电口特写.webp", "image/webp", 66430, "0a47960426ddef1405e19be350313867ca843b872b0c54b9f3b0fbc3a1d820e5", ["detail", "charging-port"]],
  ["0020", "pearl-white", "轮毂特写", "珍珠白/C10-珍珠白-04-轮毂特写.webp", "image/webp", 246018, "a3aeb4eef87edd8fdea54610beb20de445a892108cd17223b7463c88c0d5aea8", ["detail", "wheel"]],
  ["0021", "pearl-white", "前灯带与车标特写", "珍珠白/C10-珍珠白-05-前灯带与车标特写.jpg", "image/jpeg", 1231746, "ed62bf378dfc9cb52b4109a0c5b6d4b44dacb9ef3af01ffc2bad009364bdadb8", ["detail", "light-bar", "badge"]],
  ["0022", "pearl-white", "整车正前", "珍珠白/C10-珍珠白-06-整车正前.jpg", "image/jpeg", 2573962, "141d78e0f575b4112a79ec06a52695ad2bd22f1c551a5578edf91874d0c548fe", ["full-vehicle", "front-view"]],
  ["0023", "pearl-white", "整车左前45度", "珍珠白/C10-珍珠白-07-整车左前45度.jpg", "image/jpeg", 2553468, "a2feef0cedec53088f2a4b47252937a9429480a926d7997a3f06b8930dccb584", ["full-vehicle", "left", "front-three-quarter"]],
  ["0024", "pearl-white", "整车右前45度", "珍珠白/C10-珍珠白-08-整车右前45度.jpg", "image/jpeg", 2677311, "ead63ebb9a5788c3ba8cd67ad8488e178bd4dd9d6c2b772d145c0b02ff305652", ["full-vehicle", "right", "front-three-quarter"]],
  ["0025", "pearl-white", "整车正后", "珍珠白/C10-珍珠白-09-整车正后.jpg", "image/jpeg", 2568585, "76c38e7457a89bb06bcd79f14b93b03edbd5c1859d3f999896dd4f5308e096a7", ["full-vehicle", "rear-view"]],
  ["0026", "purple-space", "常规后备箱空间", "紫空间/C10-紫空间-01-常规后备箱空间.webp", "image/webp", 464294, "c0176c29e496a24d802540dc0456ae35ee010ab555bbd8c34e4c35548abb5bf7", ["space", "trunk"]],
  ["0027", "purple-space", "主驾座椅调节按钮", "紫空间/C10-紫空间-02-主驾座椅调节按钮.webp", "image/webp", 640548, "9420bd42bed10c3ff723ea05c3c560a1e27df98ad540282ddffecb201759bb61", ["detail", "driver-seat-control"]],
  ["0028", "purple-space", "后排空调出风口", "紫空间/C10-紫空间-03-后排空调出风口.webp", "image/webp", 337192, "30c80fc39ffd034d34b6170b41bde78f9ff8646cdf79748b73d2a10885618ae2", ["detail", "rear-air-vent"]],
  ["0029", "purple-space", "全景天窗", "紫空间/C10-紫空间-04-全景天窗.webp", "image/webp", 142760, "21df5a81b10e25c1f725a95a3e0eae5c4e67d3ed79c25c2772bed9030e1b611b", ["detail", "panoramic-roof"]],
  ["0030", "purple-space", "后排乘坐空间侧视", "紫空间/C10-紫空间-05-后排乘坐空间侧视.webp", "image/webp", 289502, "681402e2410b0fb5343a351beb688c68738c12bf46d8c100f08b0387b39b090e", ["space", "rear-seat", "side-view"]],
  ["0031", "purple-space", "中央扶手储物箱", "紫空间/C10-紫空间-06-中央扶手储物箱.webp", "image/webp", 166934, "081dfeefcf7a4c4ba6f046db1e35f8aa41c06f9583eb0b75308867c8f67f11be", ["detail", "console-storage"]],
  ["0032", "purple-space", "中央扶手与杯架", "紫空间/C10-紫空间-07-中央扶手与杯架.webp", "image/webp", 245994, "8c12958963fae0bfdfab36f42597578f94ae75cef807f1545ff2dd806ab774a9", ["detail", "center-armrest", "cup-holder"]],
  ["0033", "purple-space", "前排座椅侧视", "紫空间/C10-紫空间-08-前排座椅侧视.webp", "image/webp", 303568, "57a2b08c779de6c8df8dd7e5413a33d8e249acd1d174bad799c7637cf5f75fd7", ["space", "front-seat", "side-view"]],
  ["0034", "purple-space", "后排放倒后备箱", "紫空间/C10-紫空间-09-后排放倒后备箱.webp", "image/webp", 427054, "918d50da9e2c0fb8738ab91cda2de97d92831d60cf2377a26596c6e1053252d9", ["space", "trunk", "rear-seat-folded"]],
  ["0035", "purple-space", "后排小桌板", "紫空间/C10-紫空间-10-后排小桌板.webp", "image/webp", 255786, "b7db5a8873310ab608f941edce40e8fd9759cd6f770d9b155dc169e5141ef139", ["detail", "rear-table"]],
  ["0036", "purple-space", "后排座椅全景", "紫空间/C10-紫空间-11-后排座椅全景.webp", "image/webp", 321432, "1e80c1d28f0cf4d0db44c215e64a0ef078290b1478e8e57ab984cec36b72857c", ["space", "rear-seat", "wide-view"]],
  ["0037", "purple-interior", "前排座舱全景", "紫内饰/C10-紫内饰-01-前排座舱全景.webp", "image/webp", 392244, "c6a45decf7152f862d3105ca65022fa9b1728710e6742b9d7eecc21525e39680", ["cockpit", "wide-view"]],
  ["0038", "purple-interior", "中控屏主页", "紫内饰/C10-紫内饰-02-中控屏主页.webp", "image/webp", 85346, "c11bda8c3240650f4e0f09dca0658e748ed7feff50d09a14ed96ce804260bd34", ["detail", "center-display", "home-screen"]],
  ["0039", "purple-interior", "方向盘特写", "紫内饰/C10-紫内饰-03-方向盘特写.webp", "image/webp", 284872, "525ffd7b24a238d87418184b0bcd9911f5d9315a5d866ec8ec66581972e30422", ["detail", "steering-wheel"]],
  ["0040", "purple-interior", "仪表屏特写", "紫内饰/C10-紫内饰-04-仪表屏特写.webp", "image/webp", 203186, "fcca16296f0156b40d3ff39989a4654b2ba37a38035ab9bc8dc141fe5d879d16", ["detail", "instrument-display"]],
  ["0041", "purple-interior", "中控屏车辆设置", "紫内饰/C10-紫内饰-05-中控屏车辆设置.webp", "image/webp", 151250, "4b8a3973eee41191b9f320bef2d121781fb69173e42c70e4295b6822cd696043", ["detail", "center-display", "vehicle-settings"]],
  ["0042", "purple-interior", "驾驶舱中控全景", "紫内饰/C10-紫内饰-06-驾驶舱中控全景.webp", "image/webp", 296068, "2d88224d48180d4c7ab52822e79a19a35e781ab79e25b3686c6ed49fd8fad551", ["cockpit", "dashboard", "wide-view"]],
  ["0043", "brown-space", "后排放倒后备箱", "棕空间/C10-棕空间-01-后排放倒后备箱.webp", "image/webp", 207638, "1f1db6f4a899e39df237121c1b80505c74ad75f3a1d9fbd837ce8f5919bc79b7", ["space", "trunk", "rear-seat-folded"]],
  ["0044", "brown-space", "前排中央扶手", "棕空间/C10-棕空间-02-前排中央扶手.webp", "image/webp", 72776, "6691142446b1918b48b1cb815dfc29b56d9e06a6112d2f7e8099d4507e7d211c", ["detail", "front-armrest"]],
  ["0045", "brown-space", "主驾座椅调节按钮", "棕空间/C10-棕空间-03-主驾座椅调节按钮.webp", "image/webp", 101680, "e8b7af8af69982401b9f70b87b56cacc9c70cbb74de15cb759094e1c2649e23b", ["detail", "driver-seat-control"]],
  ["0046", "brown-space", "后排乘坐空间侧视", "棕空间/C10-棕空间-04-后排乘坐空间侧视.webp", "image/webp", 191856, "d542aea645baa8e4e21c8816778ffe72b7234aa218611ff5781f67d659930336", ["space", "rear-seat", "side-view"]],
  ["0047", "brown-space", "前排座椅侧视", "棕空间/C10-棕空间-05-前排座椅侧视.webp", "image/webp", 221484, "50914ea7307cbcbdaa204925c52da812fc1035b2fe944a67d199c61617315300", ["space", "front-seat", "side-view"]],
  ["0048", "brown-space", "后排座椅全景", "棕空间/C10-棕空间-06-后排座椅全景.webp", "image/webp", 208662, "ced5254a46c9fdead0db759a1e70362f30fb85fb692f69eb98d83e9afb051415", ["space", "rear-seat", "wide-view"]],
  ["0049", "brown-space", "中央扶手储物箱", "棕空间/C10-棕空间-07-中央扶手储物箱.webp", "image/webp", 103486, "c8ca07f71b9a3559a764c04181b56dcd84d7aad329defce7977d102990aad65b", ["detail", "console-storage"]],
  ["0050", "brown-space", "常规后备箱空间", "棕空间/C10-棕空间-08-常规后备箱空间.webp", "image/webp", 177224, "6f037b298f1fa4f5d85f3a714b0dd4bb2256ebf3d411e04334498a22474e1d14", ["space", "trunk"]],
  ["0051", "brown-space", "全景天窗", "棕空间/C10-棕空间-09-全景天窗.webp", "image/webp", 133466, "e3f7bfcaa394b41ff3f38295ff7e334f9d517f50b56495c520ccf3af0716d200", ["detail", "panoramic-roof"]],
  ["0052", "brown-interior", "前排中控台全景", "棕内饰/C10-棕内饰-01-前排中控台全景.webp", "image/webp", 130366, "4eeca98d6389b19439ef351f2fb43a7251a6f413a686b98879313ed7d86749a7", ["cockpit", "dashboard", "wide-view"]],
  ["0053", "brown-interior", "前排座舱全景", "棕内饰/C10-棕内饰-02-前排座舱全景.webp", "image/webp", 262108, "dbf35838109dc4813784d8f5720026c812e5b107d3f6093d1c913275a0cf9de5", ["cockpit", "wide-view"]],
  ["0054", "brown-interior", "中控屏全景影像", "棕内饰/C10-棕内饰-03-中控屏全景影像.webp", "image/webp", 218880, "422b98266b1dbdb34a2487266830782245812db8567a7dcbd5d8dcc4ff91cb80", ["detail", "center-display", "surround-view"]],
  ["0055", "brown-interior", "仪表屏特写", "棕内饰/C10-棕内饰-04-仪表屏特写.webp", "image/webp", 70938, "a004960842b6cb5e469918bdc25f29cf26734a845b161640cfd5d8215e04d168", ["detail", "instrument-display"]],
];

function manifestEntry(row: ManifestRow): MockCompanyAssetMediaManifestEntry {
  const [serial, groupKey, subject, sourceRelativePath, mediaType, byteSize, checksumSha256, tags] = row;
  const group = sourceGroups[groupKey];
  const assetId = `asset_leapmotor_c10_${serial}`;
  return Object.freeze({
    bundleId: LEAPMOTOR_C10_MOCK_ASSET_BUNDLE_ID,
    ...LEAPMOTOR_C10_MOCK_ASSET_BINDING,
    assetId,
    version: 1,
    displayName: `C10 ${group.label}—${subject}`,
    visualDescription: visualDescriptionForMockCompanyAsset(assetId),
    tags: Object.freeze(["c10", "vehicle", ...group.tags, ...tags]),
    mediaType,
    width: 2508,
    height: 1672,
    byteSize,
    checksumSha256,
    relativePath: `leapmotor-c10/v1/${sourceRelativePath}`,
    updatedAt: "2026-08-20T00:00:00.000Z",
  });
}

export const mockCompanyAssetMediaManifest: readonly MockCompanyAssetMediaManifestEntry[] =
  Object.freeze(rows.map(manifestEntry));

const describedAssetIds = Object.keys(mockCompanyAssetVisualDescriptions);
const manifestAssetIds = new Set(mockCompanyAssetMediaManifest.map((entry) => entry.assetId));
if (
  describedAssetIds.length !== mockCompanyAssetMediaManifest.length ||
  describedAssetIds.some((assetId) => !manifestAssetIds.has(assetId))
) {
  throw new Error("The mock company asset media manifest and visual descriptions do not match.");
}

const manifestByVersionedAssetId = new Map(
  mockCompanyAssetMediaManifest.map((entry) => [`${entry.assetId}:${entry.version}`, entry]),
);

if (manifestByVersionedAssetId.size !== mockCompanyAssetMediaManifest.length) {
  throw new Error("The mock company asset media manifest contains duplicate asset versions.");
}

export function findMockCompanyAssetMedia(
  assetId: string,
  version: number,
): MockCompanyAssetMediaManifestEntry | undefined {
  return manifestByVersionedAssetId.get(`${assetId}:${version}`);
}


