import { Column, Entity, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { FixtureCustomer } from '../../customer/entities/fixture-customer.entity';

@Entity('fixture-orders')
export class FixtureOrder {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'integer' })
  totalCents: number;

  @ManyToOne(() => FixtureCustomer, (customer) => customer.orders)
  customer: FixtureCustomer;
}
