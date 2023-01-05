const express = require('express');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const jwt = require('jsonwebtoken');
const cors = require('cors');
require('dotenv').config();
const stripe = require('stripe')(process.env.STRIPE_SECRET);

const app = express();
const port = process.env.PORT || 5000;
const dbURI = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.l80pesm.mongodb.net/?retryWrites=true&w=majority`;
const dbClient = new MongoClient(dbURI, { useNewUrlParser: true, useUnifiedTopology: true, serverApi: ServerApiVersion.v1 });

// Middleware
app.use(cors());
app.use(express.json());

const verifyJWT = (req, res, next) => {
	const authHeader = req.headers.authorization;
	if (!authHeader) {
		return res.status(401).send({ message: 'Unauthorized access!' });
	}
	const token = authHeader?.split(' ')[1];

	jwt.verify(token, process.env.ACCESS_TOKEN, (err, decoded) => {
		if (err) {
			return res.status(403).send({ message: 'Forbidden access!' });
		}
		req.decoded = decoded;

		next();
	})
}

// APIs
app.get('/', (req, res) => {
	res.send('Doctors Portal server is running!');
});

// Run
const run = async () => {
	try {
		const db = dbClient.db('doctorsPortal');
		const infosCollection = db.collection('infos');
		const appointmentServicesCollection = db.collection('appointmentServices');
		const bookingsCollection = db.collection('bookings');
		const usersCollection = db.collection('users');
		const doctorsCollection = db.collection('doctors');
		const paymentsCollection = db.collection('payments');

		// Make sure run after verifyJWT
		const verifyLoggedIn = async (req, res, next) => {
			const email = req.query.email;
			const decodedEmail = req.decoded?.email;

			if (email !== decodedEmail) {
				return res.status(403).send({ message: 'Forbidden access!' });
			}
			next();
		}

		// Make sure run after verifyJWT
		const verifyAdmin = async (req, res, next) => {
			const email = req.query.email;
			const decodedEmail = req.decoded?.email;

			// Check for user is logged in
			if (email !== decodedEmail) {
				return res.status(403).send({ message: 'Forbidden access!' });
			}

			// Check for user is admin
			const user = await usersCollection.findOne({ email: decodedEmail });
			if ('admin' !== user?.role) {
				return res.status(403).send({ message: 'Forbidden access!' });
			}
			next();
		}

		// Infos
		app.get('/infos', async (req, res) => {
			const query = {}
			const infos = await infosCollection.find(query).toArray();

			res.send(infos);
		});

		// Appointment Services
		app.get('/appointmentServices', async (req, res) => {
			const date = req.query.date;

			const query = {};
			const appointmentServices = await appointmentServicesCollection.find(query).toArray();

			// Get booking in provided date
			const bookingQuery = { appointmentDate: date };
			const bookingsInDate = await bookingsCollection.find(bookingQuery).toArray();

			appointmentServices.forEach(aps => {
				const serviceBooked = bookingsInDate.filter(book => book.serviceId === aps._id.toString());
				const bookedSlots = serviceBooked.map(booked => booked.serviceSlot);
				const remainingSlots = aps.slots.filter(s => !bookedSlots.includes(s));

				aps.slots = remainingSlots;
			});

			res.send(appointmentServices);
		});

		app.get('/appointmentServices/:id', async (req, res) => {
			const id = req.params.id;

			const query = { _id: ObjectId(id) }
			const appointmentService = await appointmentServicesCollection.findOne(query);

			res.send(appointmentService);
		});

		app.get('/v2/appointmentServices', async (req, res) => {
			const date = req.query.date;

			const appointmentServices = await appointmentServicesCollection.aggregate([
				{
					$lookup: {
						from: 'bookings',
						localField: 'name',
						foreignField: 'serviceName',
						pipeline: [{
							$match: {
								$expr: {
									$eq: ['$appointmentDate', date]
								}
							}
						}],
						as: 'booked'
					}
				},
				{
					$project: {
						_id: 1,
						slots: 1,
						booked: {
							$map: {
								input: '$booked',
								as: 'book',
								in: '$$book.slot'
							}
						}
					}
				},
				{
					$project: {
						_id: 1,
						slots: {
							$setDifference: ['$slots', '$booked']
						}
					}
				}
			]).toArray();

			res.send(appointmentServices);
		});

		app.get('/appointmentSpecialty', async (req, res) => {
			const query = {}

			const appointmentSpecialty = await appointmentServicesCollection.find(query).project({ name: 1 }).toArray();

			res.send(appointmentSpecialty);
		});

		// Temporary update specific data field
		// app.get('/addPriceToAPServices', async (req, res) => {
		// 	const filter = {};
		// 	const updatedDoc = {
		// 		$set: { price: 99 }
		// 	}
		// 	const options = { upsert: true };

		// 	const result = await appointmentServicesCollection.updateMany(filter, updatedDoc, options);
		// 	res.send(result);
		// });

		// Bookings
		app.get('/bookings', async (req, res) => {
			const email = req.query.email;

			const query = { email }
			const bookings = await bookingsCollection.find(query).toArray();

			res.send(bookings);
		});

		app.get('/bookings/:id', async (req, res) => {
			const id = req.params.id;

			const query = { _id: ObjectId(id) };
			const booking = await bookingsCollection.findOne(query);

			res.send(booking);
		});

		app.post('/bookings', verifyJWT, verifyLoggedIn, async (req, res) => {
			const booking = req.body;

			const query = {
				appointmentDate: booking.appointmentDate,
				serviceId: booking.serviceId,
				email: booking.email
			};

			const alreadyBooked = await bookingsCollection.find(query).toArray();
			if (alreadyBooked.length) {
				return res.send({ acknowledged: false, message: `You already have a booking on ${booking.serviceName}` })
			}

			const bookings = await bookingsCollection.insertOne(booking);

			res.send(bookings);
		});

		// Users
		app.get('/users', verifyJWT, verifyAdmin, async (req, res) => {
			const query = {}
			const users = await usersCollection.find(query).toArray();

			res.send(users);
		});

		app.post('/users', async (req, res) => {
			const data = req.body;

			const user = await usersCollection.findOne({ email: data?.email });

			if (!user) {
				const result = await usersCollection.insertOne(data);
				return res.send(result)
			}
			res.send({ message: 'User already added' });
		});

		app.get('/users/admin/:email', async (req, res) => {
			const email = req.params.email;
			const query = { email };

			const user = await usersCollection.findOne(query);
			res.send({ isAdmin: 'admin' === user?.role })
		})

		app.put('/users/admin/:id', verifyJWT, verifyAdmin, async (req, res) => {
			const id = req.params.id;
			const filter = { _id: ObjectId(id) };
			const updatedDoc = {
				$set: { role: 'admin' }
			}
			const options = { upsert: true };

			const result = usersCollection.updateOne(filter, updatedDoc, options);
			res.send(result);
		});

		// Doctors
		app.get('/doctors', verifyJWT, verifyAdmin, async (req, res) => {
			const query = {}
			const doctors = await doctorsCollection.find(query).toArray();

			res.send(doctors);
		});

		app.post('/doctors', verifyJWT, verifyAdmin, async (req, res) => {
			const data = req.body;

			const result = await doctorsCollection.insertOne(data);

			return res.send(result);
		});

		app.delete('/doctors/:id', verifyJWT, verifyAdmin, async (req, res) => {
			const id = req.params.id;

			const query = { _id: ObjectId(id) }
			const result = await doctorsCollection.deleteOne(query);

			res.send(result);
		});

		// Stripe
		app.post('/create-payment-intent', async (req, res) => {
			const { price } = req.body;
			const amount = parseFloat(price) * 100;

			const paymentIntent = await stripe.paymentIntents.create({
				amount,
				currency: 'usd',
				payment_method_types: ['card']
			});

			res.send({ clientSecret: paymentIntent.client_secret });
		});

		// Payments
		app.post('/payments', async (req, res) => {
			const payment = req.body;
			const { bookingId, transactionId } = payment;

			const result = await paymentsCollection.insertOne(payment);

			const filter = { _id: ObjectId(bookingId) };
			const updatedDoc = {
				$set: {
					paid: true,
					transactionId
				}
			}
			const updateResult = await bookingsCollection.updateOne(filter, updatedDoc);

			res.send(result);
		})

		// Jwt
		app.get('/jwt', async (req, res) => {
			const email = req.query.email;

			const user = await usersCollection.findOne({ email });

			if (user) {
				const token = jwt.sign({ email }, process.env.ACCESS_TOKEN, { expiresIn: '1h' });
				return res.send({ accessToken: token });
			}
			res.status(401).send({ accessToken: '' });
		});
	}
	finally { }
}
run().catch(console.log);

// Listener
app.listen(port, () => {
	console.log(`Doctors Portal server is running on port ${port}`);
});