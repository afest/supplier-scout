// Контракт данных — раздел 2 «Модель данных» логики сервиса (T-510).
// Единица данных — поле с происхождением, а не голое значение.

export type FieldStatus = "found" | "claimed" | "not_found" | "estimated" | "user";

export interface Field<T> {
  value: T | null;
  status: FieldStatus;
  /** id из справочника источников карточки (meta.sources) */
  sources: string[];
  /** дословная цитата со страницы; без цитаты значение со слов поставщика не принимается */
  quote: string | null;
  /** для not_found: где искали */
  searched_in: string[] | null;
  /** для estimated: на чём основана оценка */
  basis: string | null;
  collected_at: string;
  /** источники расходятся: второе значение со своей цитатой и ссылкой */
  alternatives?: Field<T>[];
}

export type SourceKind = "site" | "registry" | "search" | "market" | "user";

export interface Source {
  id: string;
  kind: SourceKind;
  url: string;
  title: string;
  fetched_at: string;
}

export type Unit = "RUB" | "kg" | "pcs" | "box";

export interface MinOrder {
  amount: number | null;
  unit: Unit;
  text: string;
}

export type PriceMode = "pricelist" | "partial" | "on_request" | "after_login";

export interface Prices {
  mode: PriceMode;
  pricelist_url: string | null;
  examples: { item: string; price: string }[];
}

export interface Delivery {
  to_door: boolean;
  free_from: number | null;
  cost: number | null;
  lead_time: string | null;
  pickup: boolean;
  zones: string | null;
  /** склад в другом городе, везут транспортной компанией */
  transport_company: boolean;
}

export interface Declaration {
  number: string;
  status: "действует" | "прекращена";
  product: string;
  valid_to: string;
  url: string;
}

export type CompanyStatus = "active" | "liquidating" | "liquidated" | "bankrupt";

export interface Company {
  form: "ООО" | "ИП" | "АО";
  status: CompanyStatus;
  registered_at: string;
  okved_main: string;
  okved_title: string;
  okved_match: boolean;
  revenue: { year: number; mln: number }[];
  staff: number | null;
  flags: string[];
}

/** Позиция ассортимента — как названа на сайте; название дословно есть на странице-источнике. */
export interface AssortmentItem {
  name: string;
  group: string | null;
  price: string | null;
}

/** Полный ассортимент с каталога или прайса (T-535). Пока не собран — интерфейс берёт `products`. */
export interface Assortment {
  items: AssortmentItem[];
  total_seen: number;
  truncated: boolean;
  from: "catalog" | "pricelist" | "site";
}

/** Режим работы и окно доставки (T-535): маленькой точке в ТЦ важно, привезут ли до открытия или вечером. */
export interface Hours {
  office: string | null;
  order_cutoff: string | null;
  delivery_days: string | null;
  delivery_window: string | null;
  evening_or_night: boolean | null;
}

export type Presence = "warehouse" | "delivery_only" | "unknown";
export type TaxRegime = "general" | "usn";

export interface Supplier {
  id: string;
  name: string;
  /** поставщик придуман целиком — в интерфейсе плашка «демо» */
  demo: boolean;
  /** появляется в наборе только после живого сбора («Добавить по сайту или ИНН») */
  live_only?: "site" | "inn";
  /** основная категория — для рекомендации «вся категория» и счётчиков */
  category: string;
  /** подкатегории по ассортименту (T-538), в том числе из чужих категорий: стаканы продаёт и оптовик продуктов */
  subcategories: string[];
  /** позиции-основания: почему поставщик в подкатегории — до пяти названий с сайта */
  subcategory_basis?: Record<string, string[]>;
  city: string;

  legal_name: Field<string>;
  inn: Field<string>;
  products: Field<string[]>;
  /** T-535; до сбора поля нет */
  assortment?: Field<Assortment>;
  /** T-535; до сбора поля нет */
  hours?: Field<Hours>;
  address: Field<string>;
  presence: Field<Presence>;
  regions_served: Field<string[]>;
  phones: Field<string[]>;
  emails: Field<string[]>;
  messengers: Field<string[]>;
  website: Field<string>;
  map_link: string | null;
  works_with_horeca: Field<boolean>;
  min_order: Field<MinOrder>;
  prices: Field<Prices>;
  /** ориентир рынка, когда цены «по запросу» или после входа */
  price_estimate?: Field<string>;
  delivery: Field<Delivery>;
  payment_terms: Field<string>;
  documents: {
    declarations: Field<Declaration[]>;
    /** группы «Честного знака»; только для категорий с маркировкой (рыба, молочное) */
    marking: Field<string[]> | null;
    site_mentions: Field<string>;
  };
  company: Field<Company>;
  tax_regime: Field<TaxRegime>;
  /** конвейер решил, что это не поставщик — стоп-условие, можно вернуть руками */
  not_supplier: string | null;
  meta: {
    collected_at: string;
    pipeline_version: string;
    sources: Source[];
    not_collected_reason: string | null;
    pages: number;
  };
}

/** Подкатегория — что закупают (T-538). Членство считает конвейер по правилам include / exclude из data/categories.json;
 *  keywords — слова закупщика для поиска по товару. */
export interface Subcategory {
  id: string;
  name: string;
  keywords: string[];
}

export interface Category {
  id: string;
  name: string;
  short: string;
  illustration: string;
  glyph: "fish" | "cheese" | "rice" | "box";
  /** рыба и молочное: без документов закупка невозможна, вес документов +10 */
  docs_critical: boolean;
  marking_group: string | null;
  subcategories: Subcategory[];
}

export interface Dataset {
  meta: {
    fixture: boolean;
    note: string;
    city: { id: string; name: string; region: string };
    collected_at: string;
    pipeline_version: string;
  };
  categories: Category[];
  suppliers: Supplier[];
}
