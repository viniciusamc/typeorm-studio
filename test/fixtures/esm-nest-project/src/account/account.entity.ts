import { Column, Entity, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import type { Relation } from 'typeorm';
import { FixtureInvoice } from '../invoice/invoice.entity.js';

export enum FixtureAccountStatus {
  Active = 'active',
  Suspended = 'suspended',
}

@Entity('fixture-accounts')
export class FixtureAccount {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  name!: string;

  @Column({
    type: 'enum',
    enum: FixtureAccountStatus,
    default: FixtureAccountStatus.Active,
  })
  status!: FixtureAccountStatus;

  @OneToMany(() => FixtureInvoice, (invoice) => invoice.account)
  invoices!: Relation<FixtureInvoice>[];
}
