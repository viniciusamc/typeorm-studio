import { Column, Entity, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { FixtureOrder } from '../../order/entities/fixture-order.entity';

@Entity('fixture-customers')
export class FixtureCustomer {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  displayName: string;

  @OneToMany(() => FixtureOrder, (order) => order.customer)
  orders: FixtureOrder[];
}
