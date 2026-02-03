interface PageHeaderProps {
  title: string;
  description?: string;
  action?: React.ReactNode;
  children?: React.ReactNode;
}

export function PageHeader({ title, description, action, children }: PageHeaderProps) {
  return (
    <div className="flex items-center justify-between border-b px-6 py-4">
      <div>
        <h1 className="text-2xl font-semibold">{title}</h1>
        {description !== undefined && (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      <div className="flex items-center gap-2">
        {action}
        {children}
      </div>
    </div>
  );
}
