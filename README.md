
# 🍕 SliceStack — Server

The backend API for SliceStack, a full-stack pizza ordering platform. Built with Node.js and Express.js, it handles authentication, authorization, vendor operations, menu management, orders, reviews, image uploads, and Stripe payments.

## ✨ Features

### Authentication & Authorization
- User authentication and role-based access control.
- Separate customer, vendor, and admin permissions.
- Protected API endpoints.
- Vendor account approval and suspension protection.

### Vendor Management
- Vendor registration and admin approval.
- Vendor profile management.
- Vendor approval, rejection, and resubmission workflows.
- Menu item management.
- Free and Premium vendor subscription limits.

### Menu Management
- Create, update, and delete menu items.
- Admin approval and rejection of menu items.
- Menu availability management.
- Public menu filtering by approval and availability status.
- Category-based menu filtering.

### Order Management
- Customer order creation and management.
- Vendor order operations.
- Duplicate-order protection.
- Order ownership validation.

### Payment Integration
- Stripe Checkout Session creation.
- Premium subscription checkout.
- Stripe webhook integration.
- Payment verification and ownership validation.
- Idempotent payment processing.
- Free plan: Maximum 3 eligible menu items.
- Premium plan: Unlimited eligible menu items.

### Additional Features
- Image uploads through the backend.
- Customer favorites.
- Customer reviews.
- Admin platform management.
- Input validation and error handling.

## 🛠️ Technology Stack

| Category | Technologies |
|---|---|
| Runtime | Node.js |
| Backend Framework | Express.js |
| Language | JavaScript / TypeScript (verify actual server source) |
| Database | Configured project database |
| Authentication | Project authentication implementation |
| Payments | Stripe |
| API Architecture | REST API |
| File Uploads | Backend upload implementation |

> Check `package.json` for the exact dependencies and versions used by the server.

## 🚀 Getting Started

### Prerequisites

- Node.js 20+
- npm
- Configured database
- Stripe account for payment functionality

### Installation

1. Clone the repository:

   ```bash
   git clone <SERVER_REPOSITORY_URL>
   ```

2. Navigate to the project directory:

   ```bash
   cd slicestack-server
   ```

3. Install dependencies:

   ```bash
   npm install
   ```

4. Create a `.env` file in the project root.

5. Configure the required environment variables.

6. Start the development server using the script defined in `package.json`:

   ```bash
   npm run dev
   ```

## 🔐 Environment Variables

Configure the following variables according to the actual backend implementation.

```env
PORT=
DATABASE_URL=

CLIENT_URL=

STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
```

> These are configuration placeholders, not a verified list of your actual environment variable names. Match them with the server's source code and `.env.example` before publishing.

## 🌐 API & Project Links

- **Live Website:** [SliceStack](https://slicestack.vercel.app)
- **Live API:** <SERVER_API_URL>
- **Client Repository:** [GitHub](<CLIENT_REPOSITORY_URL>)
- **Server Repository:** [GitHub](<SERVER_REPOSITORY_URL>)

## 📁 Project Structure

```text
slicestack-server/
├── src/
│   ├── config/
│   ├── controllers/
│   ├── middlewares/
│   ├── models/
│   ├── routes/
│   ├── services/
│   ├── utils/
│   └── app.js
├── uploads/
├── .env
├── .env.example
├── package.json
└── README.md
```

*Adjust the structure to match the actual backend folders and filenames.*

## 🔒 Security

- Role-based authorization.
- Protected routes and resources.
- Server-side payment verification.
- Stripe webhook signature verification.
- Ownership validation for protected operations.
- Environment-based secret management.

## 👨‍💻 Author

**Kamrul Islam**

Full Stack MERN Developer

---

Fresh slices. Fast delivery. Good times. 🍕
