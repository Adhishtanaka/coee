import express from 'express';
import { ordersRouter } from './routes/orders';
import { requireUser } from './middleware/auth';

const app = express();
app.use(express.json({ limit: '100kb' }));
app.use('/orders', requireUser, ordersRouter);

app.listen(Number(process.env.PORT ?? 3000), () => console.log('orders api ready'));
