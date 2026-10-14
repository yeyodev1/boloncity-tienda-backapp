import { IProductOption } from "../models/Product";

export interface ChosenOption {
  name: string;
  value: string;
}

/**
 * Limpia los grupos de opciones que manda el admin: sin nombre o sin elecciones
 * no sirven, y las elecciones repetidas se descartan.
 */
export function parseProductOptions(value: unknown): IProductOption[] {
  let raw = value;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];

  return raw
    .map((group) => {
      const name = String(group?.name || "").trim();
      const choices = Array.isArray(group?.choices)
        ? [...new Set(group.choices.map((choice: unknown) => String(choice || "").trim()).filter(Boolean))] as string[]
        : [];
      return { name, required: group?.required !== false, choices };
    })
    .filter((group) => group.name && group.choices.length > 0);
}

/**
 * Cruza lo que eligio el cliente con las opciones del producto. Solo se aceptan
 * elecciones que existan en el catalogo, asi el pedido nunca lleva texto libre.
 *
 * @returns las opciones validas en el orden del producto, o el nombre del grupo
 * obligatorio que falta.
 */
export function resolveChosenOptions(
  productOptions: IProductOption[] | undefined,
  chosen: unknown
): { options: ChosenOption[]; missing?: string } {
  const picked = Array.isArray(chosen) ? (chosen as Partial<ChosenOption>[]) : [];
  const options: ChosenOption[] = [];

  for (const group of productOptions || []) {
    const match = picked.find((option) => String(option?.name || "").trim() === group.name);
    const value = String(match?.value || "").trim();
    if (value && group.choices.includes(value)) {
      options.push({ name: group.name, value });
    } else if (group.required) {
      return { options, missing: group.name };
    }
  }

  return { options };
}

/** "Masa: Verde · Salsa: Queso" — para la comanda y los correos. */
export function formatChosenOptions(options: ChosenOption[] | undefined): string {
  return (options || []).map((option) => `${option.name}: ${option.value}`).join(" · ");
}
