export interface AccountView {
  id: string;
  username: string;
  loginName: string;
  status: 'active' | 'banned';
  createdAt: string;
  links: Array<{ uuid: string; username: string; status: string; linkedAt: string }>;
}
