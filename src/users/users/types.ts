export interface User {
  id: string;
  email: string;
  role: string;
  purchasedTickets: string[];
  soldTickets?: string[];
  createdAt: string;
  given_name: string;
  family_name: string;
}
