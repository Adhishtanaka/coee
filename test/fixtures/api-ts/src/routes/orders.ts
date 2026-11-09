import { Router } from 'express';
import { CreateOrderBody } from '../types';
import { cancelOrder, createOrder, priceOf } from '../services/orders';

export const ordersRouter = Router();

ordersRouter.post('/', (req, res) => {
  const body = CreateOrderBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.message });
  res.status(201).json(createOrder((req as any).userId, priceOf(body.data.items)));
});

ordersRouter.delete('/:id', (req, res) => {
  res.json(cancelOrder(req.params.id, (req as any).userId));
});
