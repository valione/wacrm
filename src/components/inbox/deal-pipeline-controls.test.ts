import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Regressão: "clicar na fase não faz nada".
 *
 * O dropdown deste projeto é base-ui (`@base-ui/react/menu`), não Radix.
 * `Menu.Item` dispara `onClick`; `onSelect` é o contrato do RADIX e é
 * silenciosamente ignorado aqui. Pior: `MenuItemProps` estende
 * `BaseUIComponentProps<'div', …>` e o React tipa `onSelect` como evento
 * DOM válido de qualquer elemento — então `tsc` NÃO acusa nada e o item
 * fica inerte em runtime.
 *
 * Este teste lê o fonte porque o repo não tem jsdom/testing-library: sem
 * DOM não há como simular o clique. Ele fixa o contrato para a próxima
 * pessoa que portar um padrão do Radix para cá.
 */
const source = readFileSync(
  join(__dirname, "deal-pipeline-controls.tsx"),
  "utf8",
);

describe("deal-pipeline-controls usa o contrato do base-ui", () => {
  it("não passa onSelect para nenhum elemento JSX (base-ui ignora)", () => {
    expect(source).not.toMatch(/onSelect=\{/);
  });

  it("liga os itens de menu por onClick", () => {
    expect(source).toMatch(/onClick=\{/);
  });
});
