import { Food } from './food.model.js';
import { Category } from '../category/category.model.js';
import { NotFoundError } from '../../errors/NotFoundError.js';
import { ConflictError } from '../../errors/ConflictError.js';
import { BadRequestError } from '../../errors/BadRequestError.js';
import { logger } from '../../utils/logger.js';
import { generateSlug } from '../../utils/slug.js';
import { getCache, setCache, deleteCache } from '../../utils/cache.js';
import { uploadToImageKit, deleteFromImageKit } from '../../config/storage.js';

import { emitAdminEvent } from '../../utils/socketEmitter.js';
import { SOCKET_EVENTS } from '../../constants/socketEvents.js';

let trackedFoodCacheKeys = new Set();

const invalidateAllFoodCaches = async () => {
  for (const key of trackedFoodCacheKeys) {
    await deleteCache(key);
  }
  trackedFoodCacheKeys.clear();
};

export const createFood = async (foodData, imageFiles) => {
  const { name, category } = foodData;

  if (!imageFiles || imageFiles.length === 0) {
    throw new BadRequestError('At least one image is required');
  }

  const existingFood = await Food.findOne({ name });
  if (existingFood) {
    throw new ConflictError('Food with this name already exists');
  }

  const categoryExists = await Category.findById(category);
  if (!categoryExists) {
    throw new BadRequestError('Category not found');
  }

  const slug = generateSlug(name);
  const existingSlug = await Food.findOne({ slug });
  if (existingSlug) {
    throw new ConflictError('Food slug already exists');
  }

  // Upload images to ImageKit
  const uploadedImages = [];
  for (const file of imageFiles) {
    const fileName = `food-${slug}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const result = await uploadToImageKit(file.buffer, fileName, 'foods');
    uploadedImages.push({ url: result.url, fileId: result.fileId });
  }

  const food = await Food.create({
    ...foodData,
    slug,
    images: uploadedImages,
  });

  await invalidateAllFoodCaches();

  logger.info('Food created', { foodId: food._id });

  emitAdminEvent(SOCKET_EVENTS.FOOD_CREATED, {
    foodId: food._id,
    name: food.name,
    slug: food.slug,
    price: food.price,
  });

  return food;
};

export const listFoods = async (query) => {
  const {
    page = 1,
    limit = 10,
    category,
    isAvailable,
    isVegetarian,
    isSpicy,
    search,
    minPrice,
    maxPrice,
    sortBy = 'createdAt',
    sortOrder = 'desc',
  } = query;

  const cacheKey = `cache:foods:public:${page}:${limit}:${category || ''}:${isAvailable || ''}:${isVegetarian || ''}:${isSpicy || ''}:${search || ''}:${minPrice || ''}:${maxPrice || ''}:${sortBy}:${sortOrder}`;

  const cached = await getCache(cacheKey);
  if (cached) {
    return cached;
  }

  const filter = {};

  if (category) filter.category = category;
  if (isAvailable !== undefined) filter.isAvailable = isAvailable === 'true';
  if (isVegetarian !== undefined) filter.isVegetarian = isVegetarian === 'true';
  if (isSpicy !== undefined) filter.isSpicy = isSpicy === 'true';

  if (minPrice !== undefined || maxPrice !== undefined) {
    filter.price = {};
    if (minPrice !== undefined) filter.price.$gte = minPrice;
    if (maxPrice !== undefined) filter.price.$lte = maxPrice;
  }

  if (search) {
    filter.$text = { $search: search };
  }

  const sort = { [sortBy]: sortOrder === 'desc' ? -1 : 1 };
  const skip = (page - 1) * limit;

  const [foods, total] = await Promise.all([
    Food.find(filter)
      .populate('category', 'name slug')
      .sort(sort)
      .skip(skip)
      .limit(limit),
    Food.countDocuments(filter),
  ]);

  const totalPages = Math.ceil(total / limit);

  const data = {
    data: foods,
    pagination: {
      page,
      limit,
      total,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    },
  };

  trackedFoodCacheKeys.add(cacheKey);
  await setCache(cacheKey, data, 60);

  return data;
};

export const getFoodById = async (foodId) => {
  const cacheKey = `cache:foods:${foodId}`;

  const cached = await getCache(cacheKey);
  if (cached) {
    return cached;
  }

  const food = await Food.findById(foodId).populate('category', 'name slug');

  if (!food) {
    throw new NotFoundError('Food not found');
  }

  const foodData = food.toJSON();
  await setCache(cacheKey, foodData, 300);

  return foodData;
};

export const updateFood = async (foodId, updateData, imageFiles) => {
  const food = await Food.findById(foodId);

  if (!food) {
    throw new NotFoundError('Food not found');
  }

  if (updateData.name && updateData.name !== food.name) {
    const existingFood = await Food.findOne({ name: updateData.name });
    if (existingFood && existingFood._id.toString() !== foodId) {
      throw new ConflictError('Food with this name already exists');
    }
    updateData.slug = generateSlug(updateData.name);
  }

  if (updateData.category) {
    const categoryExists = await Category.findById(updateData.category);
    if (!categoryExists) {
      throw new BadRequestError('Category not found');
    }
  }

  // Replace images if new ones uploaded
  if (imageFiles && imageFiles.length > 0) {
    // Delete old images
    for (const oldImage of food.images) {
      await deleteFromImageKit(oldImage.fileId);
    }

    // Upload new images
    const uploadedImages = [];
    for (const file of imageFiles) {
      const fileName = `food-${food.slug}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const result = await uploadToImageKit(file.buffer, fileName, 'foods');
      uploadedImages.push({ url: result.url, fileId: result.fileId });
    }

    food.images = uploadedImages;
  }

  Object.assign(food, updateData);
  await food.save();

  await deleteCache(`cache:foods:${foodId}`);
  await invalidateAllFoodCaches();

  logger.info('Food updated', { foodId });

  emitAdminEvent(SOCKET_EVENTS.FOOD_UPDATED, {
    foodId,
    name: food.name,
    slug: food.slug,
    price: food.price,
  });

  return food;
};

export const deleteFood = async (foodId) => {
  const food = await Food.findById(foodId);

  if (!food) {
    throw new NotFoundError('Food not found');
  }

  // Delete images from ImageKit
  for (const image of food.images) {
    await deleteFromImageKit(image.fileId);
  }

  await Food.findByIdAndDelete(foodId);

  await deleteCache(`cache:foods:${foodId}`);
  await invalidateAllFoodCaches();

  emitAdminEvent(SOCKET_EVENTS.FOOD_DELETED, {
    foodId,
  });

  logger.info('Food deleted', { foodId });

  return true;
};
