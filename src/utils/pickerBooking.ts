/**
 * Suelta la reserva de Picker de un pedido (ya cancelada del lado de Picker).
 *
 * Mientras `picker.bookingId` tenga valor, el pedido no vuelve a pedir motorizado:
 * ni al regresar a «Listas para recolección» ni con «Reintentar delivery». Una
 * reserva muerta pegada al pedido lo dejaba sin forma de pedir otra.
 */
export function clearPickerBooking(order: { set: (path: string, value: unknown) => unknown }) {
  order.set("picker", {
    bookingId: "",
    bookingNumericId: null,
    statusText: "",
    smrURL: "",
    bookingDetailUrl: "",
    createdAt: null,
    currentStatus: "",
    driverName: "",
    driverPhone: "",
    driverVehicle: "",
    driverPhoto: "",
    validationCode: "",
    proofOfDelivery: "",
    deliveryFee: 0,
    searchState: null,
    searchStartedAt: null,
    searchResult: null,
    searchError: "",
  });
}
