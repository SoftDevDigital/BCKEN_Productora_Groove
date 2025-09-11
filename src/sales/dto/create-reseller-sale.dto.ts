export class CreateResellerSaleDto {
  eventId: string;
  batchId: string;
  quantity: number;
  buyerInfo: string; // e.g., email o nombre del comprador
}
