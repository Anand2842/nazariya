# Nazariya

Nazariya is an immersive B2B SaaS platform for real estate, providing interactive 3D and 360° virtual property walkthroughs, floorplans, and digital twin management for property developers, brokers, and rental marketplaces in India.

## Monorepo Structure

```
├── nazariya/                  # Next.js 15 full-stack web application
│   ├── src/app/              # Next.js App Router (Dashboard, Public Tour Viewers, API routes)
│   ├── src/lib/              # Core business logic, auth, storage, database schema
│   ├── drizzle/              # Drizzle ORM schema & migrations (PostgreSQL)
│   ├── tests/                # Vitest unit tests & Playwright E2E suites
│   ├── scripts/              # Migration, seeding, dev SSL, and maintenance tools
│   └── public/               # Static assets & 3D viewer vendor libraries
│
├── nazariya-business/         # Commercial strategy, unit economics & operations
│   ├── ceo-operating-plan.md # Executive roadmap & operational milestones
│   ├── production-readiness.md # Launch checklist & production infrastructure
│   ├── nazariya-unit-economics.xlsx # Financial model & pricing tier economics
│   ├── csv/                  # Pricing, unit costs, breakeven analysis datasets
│   └── tools/                # Financial modeling & pricing generation scripts
│
└── rental-platform-research/  # Rental market research & product architecture
    ├── executive-summary.md  # Market sizing & Delhi-NCR rental dynamics
    ├── rental-product-requirements.md # Feature requirements & user journeys
    ├── system-architecture.md# Technical architecture & tour pipeline
    ├── rental-data-model.md  # Domain entities & schema design
    ├── interactive-viewer-architecture.md # 3D/360° rendering specifications
    └── evidence/             # Benchmarks, metadata & competitive analyses
```

## Core Features

- **Interactive 3D / 360° Viewers**: Support for equirectangular panoramas, Photo Sphere Viewer, Gaussian Splatting (`.splat`/`.ply`), and dollhouse/floorplan modes.
- **Role-Based Workspace**: Multi-tenant organizations with Admin, Staff, and Client roles.
- **Property & Tour Management**: Self-serve asset upload, scene sequencing, hotspot placement, and instant shareable tour links.
- **Enterprise-Ready Infrastructure**: PostgreSQL via Drizzle ORM, local/cloud object storage adapters (S3/Cloudflare R2 compatible), and worker job queues.

## Getting Started

### Prerequisites

- Node.js 20+
- PostgreSQL (or use the built-in local Docker/binary launcher `npm run db:start`)

### Running the Application

```bash
cd nazariya

# Install dependencies
npm install

# Start local database (if applicable)
npm run db:start

# Run database migrations
npm run db:migrate

# Start development server
npm run dev
```

Visit [http://localhost:3100](http://localhost:3100) to view the application.

## License

Proprietary. All rights reserved.
