// Помощник — заглушка до сервера (T-536): показывает, как будет работать, и не делает вид, что работает.
import { href } from "../router.ts";

const STEPS = [
  { t: "Вы описываете точку", d: "«у меня бабл-ти в ТЦ, открываемся в 10, нужно сырьё»" },
  { t: "Помощник предлагает, что закупать", d: "вариантами-кнопками: молоко, газировка, сиропы, стаканчики, трубочки — отмечаете нужное" },
  { t: "Подбирает поставщиков из набора", d: "по их ассортименту; чего в наборе нет — честно скажет и предложит найти живым сбором" },
];

export function Assistant() {
  return (
    <div className="assistant">
      <div className="label">Помощник · в разработке</div>
      <h1 className="h1">Не знаете, что нужно?</h1>
      <p className="lead-sm">Помощнику нужен сервер: ключ языковой модели нельзя положить в браузер. Пока сервера нет, ниже — как он будет работать.</p>

      <div className="assist-mock">
        <div className="assist-in" aria-hidden="true">у меня бабл-ти в ТЦ, нужно сырьё…</div>
        <div className="assist-chips" aria-hidden="true">
          {["молоко", "газировка", "сиропы", "стаканчики с крышкой", "трубочки", "тапиока"].map((x) => <span key={x} className="pill-out sm">{x}</span>)}
        </div>
      </div>

      <ol className="pipe pipe-3">
        {STEPS.map((x, i) => (
          <li key={x.t}><span className="pipe-n num">{i + 1}</span><b>{x.t}</b><span>{x.d}</span></li>
        ))}
      </ol>

      <div className="row-btns">
        <a className="btn pr" href={href("/find")}>Искать по товару</a>
        <a className="btn sec" href={href("/categories")}>Искать по категории</a>
        <a className="btn sec" href="#/catalog">Все поставщики</a>
      </div>
    </div>
  );
}
