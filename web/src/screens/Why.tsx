// Старый адрес разбора #/why (до T-543 — отдельный экран). Разбор живёт во вкладке «Разбор» на странице поставщика;
// старые ссылки ведут туда, а не на пустой экран:
//   #/why?…&id=X       → страница X, вкладка «Разбор»
//   #/why?cat=…[&sub=…] → первый в «Кому написать первым» этой выборки
//   #/why?ids=a,b,c     → лучший из сравниваемых, рядом для сравнения — второй
import { useEffect } from "react";
import { navigate, type Route } from "../router.ts";
import { useStore } from "../store.ts";
import { byId, queryParams, rankCategory, readQuery } from "../data.ts";
import { firstToWrite } from "../lib/score.ts";

export function whyTarget(p: URLSearchParams, st: Parameters<typeof rankCategory>[1]): { id: string; params: Record<string, string | number | null> } | null {
  const id = p.get("id");
  if (id && byId.has(id)) return { id, params: { ...queryParams(readQuery(p, byId.get(id)!.category)), tab: "why" } };
  const ids = p.get("ids") ? p.get("ids")!.split(",").filter((x) => byId.has(x)) : null;
  const pp = new URLSearchParams(p);
  if (ids?.length) pp.set("cat", byId.get(ids[0])!.category);
  const q = readQuery(pp);
  const { ranked } = rankCategory(q, st, ids ? { ids } : { subsOnly: true });
  const lead = (ids ? null : firstToWrite(ranked)[0]) ?? ranked[0];
  if (!lead) return null;
  const vs = ids ? ranked.find((x) => x !== lead)?.supplier.id ?? null : null;
  return { id: lead.supplier.id, params: { ...queryParams(q), tab: "why", vs } };
}

export function Why({ route }: { route: Route }) {
  const st = useStore();
  const t = whyTarget(route.params, st);
  useEffect(() => {
    if (t) navigate(`/s/${t.id}`, t.params, { replace: true });
  }, [t?.id, JSON.stringify(t?.params)]);
  if (t) return null;
  return <div className="empty"><h1 className="h1">Некого ранжировать</h1><p><a href="#/categories">К поиску по категории →</a></p></div>;
}
