import { Column, Entity, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import type { Relation } from 'typeorm';
import { FixtureAccount } from '../account/account.entity.js';

@Entity('fixture-invoices')
export class FixtureInvoice {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'integer' })
  amountCents!: number;

  @ManyToOne(() => FixtureAccount, (account) => account.invoices)
  account!: Relation<FixtureAccount>;
}
