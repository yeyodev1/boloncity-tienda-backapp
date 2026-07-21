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
  pickerApiKey?: string
  isActive: boolean
  createdAt?: Date
  updatedAt?: Date
}

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
    pickerApiKey: { type: String, default: '' },
    isActive: { type: Boolean, default: true },
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
