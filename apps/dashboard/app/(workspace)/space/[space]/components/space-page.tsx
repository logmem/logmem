export function SpacePage({ title, body }: { title: string; body: string }) {
  return (
    <div className="space-y-4 font-sans">
      <div className="pb-4 border-b border-[#D3DAD8] dark:border-[#2B3835]">
        <h1 className="text-2xl md:text-3xl font-['Schibsted_Grotesk'] font-bold text-[#121A19] dark:text-[#E9EEEC]">
          {title}
        </h1>
      </div>
      <p className="text-sm text-[#46534F] dark:text-[#B3BEBA]">{body}</p>
    </div>
  );
}
