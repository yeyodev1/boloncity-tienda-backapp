import mongoose, { Schema } from 'mongoose'
import { slugify } from '../utils/slugify'

export interface IBranch {
  name: string
  slug: string
  address?: string
  city?: string
  phone?: string
  email?: string
  googleMapsUrl?: string
  imageUrl?: string
  imagePublicId?: string
  coordinates?: {
    lat: number
    lng: number
  } | null
  timezone: string
  openingHours: IBranchOpeningHours[]
  /** Minutos que Picker espera antes de buscar motorizado (cookTime, en ms hacia su API). */
  cookTimeMinutes: number
  pickerStore?: IPickerStore
  payphone?: IBranchPayphone
  runfood?: IBranchRunfood
  isActive: boolean
  isArchived: boolean
  createdAt?: Date
  updatedAt?: Date
}

export type BranchWeekday = 'sunday' | 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday'

export interface IBranchOpeningHours {
  day: BranchWeekday
  opensAt: string
  closesAt: string
  isOpen: boolean
}

export interface IPickerStore {
  storeApiKey?: string
  productionStoreApiKey?: string
  token?: string
  storeId?: string
  createdAt?: Date
  createdBy?: string
  creationStatus?: string
}

/**
 * Cada sucursal cobra en su propia tienda de PayPhone. El token de la cuenta es global
 * (PAYPHONE_TOKEN); lo que cambia por local es el storeId que recibe la cajita de pagos.
 */
export interface IBranchPayphone {
  storeId?: string
}

/** Conexion al POS RunFood del local (on-premise: URL y API key distintas por sucursal). */
export interface IBranchRunfood {
  enabled?: boolean
  baseUrl?: string
  apiKey?: string
}

const branchWeekdays: BranchWeekday[] = [
  'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
]

const defaultOpeningHours = (): IBranchOpeningHours[] =>
  branchWeekdays.map((day) => ({ day, opensAt: '07:00', closesAt: '13:00', isOpen: true }))

const openingHoursSchema = new Schema<IBranchOpeningHours>(
  {
    day: { type: String, required: true, enum: ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] },
    opensAt: { type: String, required: true },
    closesAt: { type: String, required: true },
    isOpen: { type: Boolean, default: true },
  },
  { _id: false }
)

const branchSchema = new Schema<IBranch>(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, index: true },
    address: { type: String, default: '' },
    city: { type: String, default: '' },
    phone: { type: String, default: '' },
    email: { type: String, default: '' },
    googleMapsUrl: { type: String, default: '' },
    imageUrl: { type: String, default: '' },
    imagePublicId: { type: String, default: '' },
    coordinates: {
      lat: { type: Number, default: null },
      lng: { type: Number, default: null },
    },
    timezone: { type: String, default: 'America/Guayaquil' },
    openingHours: {
      type: [openingHoursSchema],
      default: defaultOpeningHours,
    },
    cookTimeMinutes: { type: Number, default: 0, min: 0, max: 240 },
    pickerStore: {
      storeApiKey: { type: String, default: '', select: false },
      productionStoreApiKey: { type: String, default: '', select: false },
      token: { type: String, default: '', select: false },
      storeId: { type: String, default: '' },
      createdAt: { type: Date },
      createdBy: { type: String, default: '' },
      creationStatus: { type: String, default: '' },
    },
    payphone: {
      storeId: { type: String, default: '' },
    },
    // RunFood es el POS on-premise de cada local: URL base y API key propias por sucursal.
    runfood: {
      enabled: { type: Boolean, default: false },
      baseUrl: { type: String, default: '' },
      apiKey: { type: String, default: '', select: false },
    },
    isActive: { type: Boolean, default: true },
    isArchived: { type: Boolean, default: false },
  },
  { timestamps: true }
)

branchSchema.pre('validate', function (next) {
  if (!this.slug && this.name) {
    this.slug = slugify(this.name)
  }
  next()
})

export const Branch = mongoose.models.Branch || mongoose.model<IBranch>('Branch', branchSchema)
